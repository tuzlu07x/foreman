import { existsSync } from "node:fs";
import { Command } from "commander";
import { DbApprovalService, type ApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { ControlChannel } from "../core/control-channel.js";
import { bus } from "../core/event-bus.js";
import {
  ForemanCommandRouter,
  registerBuiltinCommands,
} from "../core/foreman-command.js";
import {
  defaultLlmConfig,
  loadLlmConfig,
} from "../core/llm/config.js";
import {
  AdapterDecodeError,
  getAdapter,
  listAdapterIds,
  type NormalisedDecision,
} from "../core/adapters/index.js";
import {
  approvalIdMissHint,
  classifyApprovalIdInput,
} from "../core/approval-id.js";
import { MediatorService } from "../core/mediator.js";
import { OrchestratorChat } from "../core/orchestrator-chat.js";
import { PendingQuestionsService } from "../core/pending-questions.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { RegistryService } from "../core/registry.js";
import { RiskScorer } from "../core/risk-scorer.js";
import { SecretStore } from "../core/secret-store.js";
import { SessionManager } from "../core/session.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { createDecoder, encodeMessage } from "../mcp/framing.js";
import type { JSONRPCMessage } from "../mcp/types.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "foreman";
const SERVER_VERSION = "0.1.0";

export const mcpStdioCommand = new Command("mcp-stdio")
  .description(
    "Serve as an MCP server over stdio so agents can route through Foreman",
  )
  .option(
    "-s, --source <id>",
    "agent id recorded as the source on every call",
    "mcp-client",
  )
  .action(async (options: { source: string }) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
      process.stderr.write(
        red("error: ") +
          `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.\n`,
      );
      process.exit(1);
    }
    const services = bootServices();
    autoRegisterSource(services.registry, options.source);
    runMcpLoop(services, options.source);
  });

interface Services {
  registry: RegistryService;
  policy: PolicyEngine;
  risk: RiskScorer;
  approval: ApprovalService;
  mediator: MediatorService;
  sessionManager: SessionManager;
  audit: AuditLogger;
  secretStore: SecretStore;
  /** #431 — Routes `/foreman <cmd>` text the agent relays via the
   *  `submit_command` MCP tool. */
  commandRouter: ForemanCommandRouter;
  /** Path to llm.yaml — needed by the LLM-status command handler. */
  llmConfigPath: string;
  /** Foreman's `<configDir>` — used by the stop handler to locate
   *  the pidfile written by `foreman start`. */
  configDir: string;
  /** #432 — Foreman LLM orchestrator chat. Built when llm.yaml is
   *  present + parseable; null otherwise (read-only verbs still work). */
  orchestratorChat: OrchestratorChat | null;
  /** #440 — Cross-process control queue. mcp-stdio is the writer
   *  side; the reader (foreman start) drains pending rows. */
  controlChannel: ControlChannel;
  /** #528 — `ask_user_with_options` MCP tool backend. The agent's
   *  blocking tool call inserts a pending_questions row + polls;
   *  the chat listener in `foreman start` writes the user's pick
   *  back via submit_user_answer. */
  pendingQuestions: PendingQuestionsService;
}

function bootServices(): Services {
  const db = getDb();
  const registry = new RegistryService(db, bus);
  const audit = new AuditLogger(db, bus);
  // Cross-process IPC via SQLite — the TUI in `foreman start` (a separate
  // process) bridges these via ApprovalBridge.
  const approval = new DbApprovalService(db, { bus, timeoutMs: 60_000 });
  const policy = new PolicyEngine(db, bus);
  const paths = getForemanPaths();
  if (existsSync(paths.policyPath)) policy.loadFromYaml(paths.policyPath);
  const risk = new RiskScorer(db, undefined, {
    bucketOverrides: () => policy.getBucketOverrides(),
    // Wire the responsibility-violation rule (#300) — same as start.ts.
    getAgentResponsibility: (agentId) =>
      registry.get(agentId)?.responsibilityNote ?? null,
    responsibilityPolicies: () => policy.getResponsibilityPolicies(),
  });
  const sessionManager = new SessionManager(db, { bus });
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  const mediator = new MediatorService({
    registry,
    policy,
    risk,
    approval,
    sessionManager,
    db,
    bus,
    secretStore,
  });
  const commandRouter = new ForemanCommandRouter();
  registerBuiltinCommands(commandRouter);
  // #432 — Build the orchestrator chat service only when llm.yaml
  // parses cleanly. A malformed config shouldn't crash MCP-stdio
  // (read-only verbs must still work).
  let orchestratorChat: OrchestratorChat | null = null;
  try {
    const llmConfig = existsSync(paths.llmConfigPath)
      ? loadLlmConfig(paths.llmConfigPath)
      : defaultLlmConfig();
    orchestratorChat = new OrchestratorChat({
      db,
      config: llmConfig,
      secretStore,
      registry,
      bus,
    });
  } catch {
    orchestratorChat = null;
  }
  // #498 — Pass the bus so enqueue events can be observed in-process
  // (tests / audit hooks). Cross-process visibility (mcp-stdio →
  // foreman start TUI) still goes through the SQLite poll in
  // useDashboardState — bus events don't cross process boundaries.
  const controlChannel = new ControlChannel(db, bus);
  const pendingQuestions = new PendingQuestionsService(db, { bus });
  return {
    registry,
    policy,
    risk,
    approval,
    mediator,
    sessionManager,
    audit,
    secretStore,
    commandRouter,
    pendingQuestions,
    llmConfigPath: paths.llmConfigPath,
    configDir: paths.configDir,
    orchestratorChat,
    controlChannel,
  };
}

function autoRegisterSource(
  registry: RegistryService,
  sourceAgent: string,
): void {
  if (registry.get(sourceAgent)) return;
  registry.register({
    id: sourceAgent,
    displayName: sourceAgent,
    transport: "stdio",
  });
}

function runMcpLoop(services: Services, sourceAgent: string): void {
  const decoder = createDecoder();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk) => {
    const { messages } = decoder.push(chunk);
    for (const message of messages) {
      const response = await handleMessage(services, sourceAgent, message);
      if (response) process.stdout.write(encodeMessage(response));
    }
  });
  process.stdin.on("end", () => {
    cleanup(services);
    process.exit(0);
  });
  const shutdown = (): void => {
    cleanup(services);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function cleanup(services: Services): void {
  services.audit.dispose();
  closeDb();
}

export async function handleMessage(
  services: Services,
  sourceAgent: string,
  msg: JSONRPCMessage,
): Promise<JSONRPCMessage | null> {
  const method = "method" in msg ? msg.method : null;
  const id = "id" in msg ? msg.id : undefined;

  // QA-fix 2026-05-24 (Wiring 5) — every JSON-RPC message from the
  // agent is a liveness signal. Bump heartbeat so `last seen` advances
  // for Hermes (and any agent that drives Foreman via MCP — Hermes
  // never goes through the spawn path because it's the chat-primary,
  // so without this it would forever show "never seen" even while
  // actively orchestrating). Best-effort: registry may be stubbed in
  // tests, the agent row may have been deleted mid-loop, etc.; we'd
  // rather swallow than break the MCP handshake.
  if (services.registry?.heartbeat) {
    try {
      services.registry.heartbeat(sourceAgent);
    } catch {
      // ignore — defensive; missing/blocked agents shouldn't break MCP
    }
  }

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "tools/list") {
    return reply(id, {
      tools: [
        {
          name: "secrets/get",
          description:
            "Fetch a stored secret by name. Policy-gated; deny-by-default unless the agent has can_access_secrets for that name.",
          inputSchema: {
            type: "object",
            required: ["name"],
            properties: {
              name: {
                type: "string",
                description: "The secret's name in the Foreman secret store.",
              },
            },
          },
        },
        {
          // #406 — Agent-routed approval flow. Foreman sends an
          // approval-request notification to the user's chat with a
          // `/approve <id>` / `/deny <id>` reply hint. When the user
          // types that command, the agent (sole polling consumer on the
          // bot) calls this tool to relay the user's decision back. See
          // SOUL.md "Approval Routing" section for the agent-side
          // routing rules.
          name: "submit_approval",
          description:
            "Submit the user's decision on a pending Foreman approval. Call this when a user message in your chat is the literal slash command `/approve <id>`, `/approve_remember <id>`, `/deny <id>`, or `/deny_remember <id>` — OR when the user taps an inline-keyboard button on a Foreman approval message (the agent receives a `callback_query` with `data: \"fa:<action_id>:<approval_id>\"`). The approval id comes from a Foreman notification message in the same chat. Pass `decision: \"allow\"` or `\"deny\"`, and `remember: true` only for the `_remember` variants. For custom action buttons (action_id starts with `block_`), pass the `action_id` so Foreman can resolve which predicate to inject + automatically deny the call. Do NOT call this on your own initiative — only when the user typed the command or tapped a Foreman button.",
          inputSchema: {
            type: "object",
            required: ["approval_id", "decision"],
            properties: {
              approval_id: {
                type: "string",
                description:
                  "Approval id Foreman included in its notification (e.g. 'abc123').",
              },
              decision: {
                type: "string",
                enum: ["allow", "deny"],
                description:
                  "User's choice — 'allow' permits the pending tool call; 'deny' blocks it. For custom action buttons (e.g. `block_secret_path`), pass `\"deny\"` — Foreman both denies the current call AND injects a permanent policy rule from the `action_id`.",
              },
              remember: {
                type: "boolean",
                description:
                  "When true, Foreman remembers this decision for the same source/target/tool combination and auto-resolves future identical calls.",
              },
              action_id: {
                type: "string",
                description:
                  "Optional. When the user tapped a custom action button (callback_data `fa:<action_id>:<approval_id>` where action_id starts with `block_`), pass the action_id so Foreman can look up the proposed predicate from the approval row + inject the corresponding deny rule into policy.yaml. The standard `allow` / `deny` / `allow_always` / `deny_always` actions don't need this field — they're inferred from `decision` + `remember`.",
              },
            },
          },
        },
        {
          // #431 — Agent-routed orchestrator command relay. User types
          // `/foreman <verb> [args]` in the agent's chat; the agent's
          // getUpdates consumer parses + calls this tool. Foreman runs
          // a built-in handler and returns text the agent posts back.
          // See SOUL.md "Orchestrator Routing" section for the rules.
          name: "submit_command",
          description:
            "Submit a /foreman orchestrator command relayed from the user's chat. Call this when a user message in your chat is `/foreman <verb> [args...]` (e.g. `/foreman status`, `/foreman help`, `/foreman llm status`). Pass the verb as `command`, the rest of the message tokens as `args` (string array). Do NOT call on your own initiative — only when the user types the literal `/foreman ...` command. The returned text is the response to post back to the user verbatim.",
          inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
              command: {
                type: "string",
                description:
                  "The first word after `/foreman` (e.g. 'status', 'help', 'llm'). Case-insensitive.",
              },
              args: {
                type: "array",
                items: { type: "string" },
                description:
                  "Remaining tokens after the verb, in order. Pass [] when none. For `/foreman llm status` this is [\"status\"].",
              },
              source_user: {
                type: "string",
                description:
                  "ALWAYS pass the messaging-platform user id of the person who typed the command (Telegram numeric `from.id`, Discord snowflake, Slack user id, …). For Telegram: this is the `from.id` field on the incoming update — NOT the chat id, though for 1:1 chats they're the same. Foreman owner-gates state-mutating verbs (`write`, `stop`, …) against this value, so omitting it WILL cause those commands to fail with NOT_AUTHORIZED. Audit-only commands still record it. When you genuinely can't get the user id (synthetic / scripted invocation), explicitly pass empty string \"\" — never just leave it off.",
              },
            },
          },
        },
        {
          // #528 — Agent-driven structured question. The agent calls
          // this tool to ask the user a multiple-choice question;
          // Foreman dispatches the question to their chat channel
          // with inline option buttons + blocks until the user picks
          // (or the timeout fires). The agent then sees the chosen
          // option (or free-form text) as the tool result.
          name: "ask_user_with_options",
          description:
            "Ask the human user a structured question with pre-defined options. Foreman pushes the question to the user's chat channel (Telegram) with tap-to-select buttons and blocks until the user answers, the timeout fires, or the user dismisses. Use for clear product decisions the user has to make (\"shadcn/ui or custom?\"). Returns `{ chosen, freeText, label, payload, outcome, answeredAt }`. Do NOT use for free-form Q&A — for that, just say what you need in chat.",
          inputSchema: {
            type: "object",
            required: ["question", "options"],
            properties: {
              question: {
                type: "string",
                description:
                  "The question shown to the user. Keep concise (≤ 200 chars).",
              },
              context: {
                type: "string",
                description:
                  "Optional context paragraph above the question. Markdown supported. Use for the 'why am I asking' framing.",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 6,
                description:
                  "2-6 options the user picks from. Each option is rendered as a tap-to-select button.",
                items: {
                  type: "object",
                  required: ["id", "label"],
                  properties: {
                    id: {
                      type: "string",
                      description:
                        "Stable id returned to you in the response's `chosen` field.",
                    },
                    label: {
                      type: "string",
                      description: "Button label the user sees.",
                    },
                    payload: {
                      type: "object",
                      description:
                        "Optional opaque payload echoed back in the response when this option is chosen.",
                    },
                  },
                },
              },
              session_id: {
                type: "string",
                description:
                  "Optional session id this question belongs to. Surfaces in `foreman log` + future session-thread views.",
              },
              timeout_seconds: {
                type: "number",
                description:
                  "How long to wait before returning a timeout response. Default 300 (5 min).",
              },
              allow_free_text: {
                type: "boolean",
                description:
                  "Default true. When true, the user can also type a free-text reply instead of tapping; the text is returned in `freeText`. Set false for strict-choice questions.",
              },
            },
          },
        },
        {
          // #528 — Agent-routed answer relay. User tapped an
          // `ask_<question_id>_<option_id>` inline-keyboard button OR
          // (when allow_free_text=true) typed a reply. The agent calls
          // this tool to deliver the answer back to Foreman, which
          // resolves the original ask_user_with_options call.
          name: "submit_user_answer",
          description:
            "Submit the user's answer to an open ask_user_with_options question. Call this when the user taps an inline-keyboard button on an `🤖 <agent> asks` message (callback_data `fa:ask_<question_id>_<option_id>:<chat_id>`) — pass `question_id` + `option_id`. When the user types a free-text reply AND `allow_free_text` was true on the original question, pass `question_id` + `free_text` instead. Do NOT call on your own initiative — only when the user tapped or replied.",
          inputSchema: {
            type: "object",
            required: ["question_id"],
            properties: {
              question_id: {
                type: "string",
                description:
                  "Question id Foreman included in its prompt (the part between `ask_` and `_<option_id>` in the callback_data).",
              },
              option_id: {
                type: "string",
                description:
                  "When the user tapped a button, the option id (e.g. 'opt-shadcn').",
              },
              free_text: {
                type: "string",
                description:
                  "When the user typed a reply instead of tapping (and the question allowed free text), the verbatim message text.",
              },
              source_user: {
                type: "string",
                description:
                  "Telegram numeric `from.id` of the user. Recorded in the audit log.",
              },
            },
          },
        },
        {
          // #527 — Agent-routed session resolution. User tapped a
          // "Skip / Let PM decide / I'll decide / Abandon" button on
          // a halt prompt; the agent's getUpdates consumer parses the
          // `fa:resolve_<option_id>:<session_id>` callback_data and
          // calls this tool. Foreman flips the session out of halt
          // (or finalizes as abandoned) + enqueues a `write` directive
          // to the participating agents so they receive the user's
          // resolution as a normal chat message.
          name: "submit_resolution",
          description:
            "Submit the user's session-resolution choice when they tap a button on a Foreman halt prompt. The callback_data is `fa:resolve_<option_id>:<session_id>`; pass both ids verbatim along with the Telegram numeric `from.id` as `source_user`. Foreman flips the session out of halt + delivers the resolution to the agents as a `foreman write` directive. Do NOT call this on your own initiative — only when the user taps a button on a `🛑 Session needs your call` message.",
          inputSchema: {
            type: "object",
            required: ["session_id", "option_id"],
            properties: {
              session_id: {
                type: "string",
                description:
                  "Session id from the callback_data tail (e.g. '01HZX...WB').",
              },
              option_id: {
                type: "string",
                description:
                  "Option id from the callback_data (e.g. 'opt-skip', 'opt-delegate-pm', 'opt-user-decide', 'opt-abandon').",
              },
              source_user: {
                type: "string",
                description:
                  "Telegram numeric `from.id` of the user who tapped the button. Recorded in the audit log alongside the resolution.",
              },
            },
          },
        },
        {
          // #552 — Generic approval-mediation tool. Any agent (or, more
          // commonly, a transport bridge sitting between an agent and
          // Foreman — e.g. the codex exec-server bridge in PR 3) can
          // call this to ask: "I'm about to do X — is that OK?"
          // Foreman runs the call through its adapter → risk → approval
          // pipeline (auto-allows low-risk, surfaces high-risk in chat)
          // and returns the agent's wire-shaped decision. The tool
          // surface is intentionally agent-agnostic: the adapter named
          // in `adapter_id` knows how to decode the opaque `wire`
          // payload and encode the resolved decision back.
          name: "request_action_approval",
          description:
            "Ask Foreman to mediate an agent action before it runs. Pass the agent's native approval-request payload as `wire` and the matching adapter id (e.g. 'codex-exec-server-v1', 'claude-code-pretooluse-v1'). Foreman decodes, scores risk, escalates to the operator when needed, and returns a `structuredContent` with both the normalised decision ('allow' | 'deny') and the adapter-encoded wire response your transport bridge can send back to the agent verbatim. Fail-closed: any decode error or unknown adapter id yields deny.",
          inputSchema: {
            type: "object",
            required: ["adapter_id", "wire"],
            properties: {
              adapter_id: {
                type: "string",
                description:
                  "Stable id of the adapter that knows this agent's wire shape — see `src/core/adapters/index.ts` `listAdapterIds()`.",
              },
              wire: {
                description:
                  "The agent's native approval-request payload. Adapter-specific shape. For codex-exec-server-v1: `{ method, params }` where method is one of `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`. For claude-code-pretooluse-v1: the PreToolUse hook stdin JSON object.",
              },
            },
          },
        },
      ],
    });
  }
  if (method === "tools/call") {
    const params = (
      msg as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      }
    ).params;
    const toolName = params?.name;

    if (toolName === "secrets/get") {
      const secretName = params?.arguments?.name;
      if (typeof secretName !== "string" || secretName.length === 0) {
        return replyError(
          id,
          -32602,
          "secrets/get requires args.name (string)",
        );
      }
      const result = await services.mediator.handleSecretGet({
        sourceAgent,
        secretName,
      });
      if (result.decision === "allowed" && result.value !== undefined) {
        return reply(id, {
          content: [{ type: "text", text: result.value }],
        });
      }
      return replyError(id, -32603, `Denied by ${result.decidedBy}`);
    }

    if (toolName === "ask_user_with_options") {
      // #528 — Agent-driven structured question. Create a pending row,
      // emit `question:asked` (NotificationBridge picks it up), block
      // until the user picks / types / dismisses / the deadline fires.
      const args = params?.arguments ?? {};
      const question =
        typeof args.question === "string" ? args.question.trim() : "";
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      const context =
        typeof args.context === "string" ? args.context : undefined;
      const sessionId =
        typeof args.session_id === "string" && args.session_id.length > 0
          ? args.session_id
          : undefined;
      const allowFreeText =
        typeof args.allow_free_text === "boolean" ? args.allow_free_text : true;
      const timeoutSeconds =
        typeof args.timeout_seconds === "number" &&
        Number.isFinite(args.timeout_seconds) &&
        args.timeout_seconds > 0
          ? args.timeout_seconds
          : 300;
      if (!question) {
        return replyError(
          id,
          -32602,
          "ask_user_with_options requires args.question (string)",
        );
      }
      if (rawOptions.length < 2 || rawOptions.length > 6) {
        return replyError(
          id,
          -32602,
          "ask_user_with_options requires 2-6 options",
        );
      }
      // Validate every option shape early so the agent sees a clear
      // error instead of a deeper "options malformed" failure later.
      const options: Array<{
        id: string;
        label: string;
        payload?: Record<string, unknown>;
      }> = [];
      for (const raw of rawOptions) {
        if (
          typeof raw !== "object" ||
          raw === null ||
          typeof (raw as { id?: unknown }).id !== "string" ||
          typeof (raw as { label?: unknown }).label !== "string"
        ) {
          return replyError(
            id,
            -32602,
            "every ask_user_with_options option needs { id: string, label: string }",
          );
        }
        const r = raw as { id: string; label: string; payload?: unknown };
        options.push({
          id: r.id,
          label: r.label,
          ...(r.payload && typeof r.payload === "object"
            ? { payload: r.payload as Record<string, unknown> }
            : {}),
        });
      }
      if (!services.pendingQuestions) {
        return replyError(
          id,
          -32603,
          "ask_user_with_options not supported by this Foreman build (pending-questions service not wired)",
        );
      }
      const resolution = await services.pendingQuestions.ask({
        sourceAgent,
        ...(sessionId !== undefined ? { sessionId } : {}),
        question,
        ...(context !== undefined ? { context } : {}),
        options,
        allowFreeText,
        timeoutMs: timeoutSeconds * 1000,
      });
      services.audit.logEvent("question:answered", {
        questionId: resolution.questionId,
        outcome: resolution.outcome,
        chosen: resolution.chosenOptionId ?? null,
        freeText: resolution.freeText ?? null,
        sourceAgent,
        sessionId: sessionId ?? null,
      });
      // Return the resolution as a single JSON-text content block so the
      // agent's tool-result parser can JSON.parse it. Same convention
      // the OpenAI MCP client + Anthropic MCP client both handle.
      const body = {
        questionId: resolution.questionId,
        chosen: resolution.chosenOptionId ?? null,
        freeText: resolution.freeText ?? null,
        label: resolution.label ?? null,
        payload: resolution.payload ?? null,
        outcome: resolution.outcome,
        answeredAt: resolution.answeredAt,
      };
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(body) }],
      });
    }

    if (toolName === "submit_user_answer") {
      // #528 — Agent-routed answer relay. Resolves the pending question
      // either by option pick or free-text. ask_user_with_options's
      // polling loop sees the row flip + returns to the original
      // tool caller.
      const args = params?.arguments ?? {};
      const questionId =
        typeof args.question_id === "string" ? args.question_id : "";
      const optionId =
        typeof args.option_id === "string" && args.option_id.length > 0
          ? args.option_id
          : undefined;
      const freeText =
        typeof args.free_text === "string" && args.free_text.length > 0
          ? args.free_text
          : undefined;
      const sourceUser =
        typeof args.source_user === "string" && args.source_user.length > 0
          ? args.source_user
          : undefined;
      if (!questionId) {
        return replyError(
          id,
          -32602,
          "submit_user_answer requires args.question_id (string)",
        );
      }
      if (!optionId && !freeText) {
        return replyError(
          id,
          -32602,
          "submit_user_answer requires args.option_id or args.free_text",
        );
      }
      if (!services.pendingQuestions) {
        return replyError(
          id,
          -32603,
          "submit_user_answer not supported by this Foreman build",
        );
      }
      const result = services.pendingQuestions.answer({
        questionId,
        ...(optionId !== undefined ? { chosenOptionId: optionId } : {}),
        ...(freeText !== undefined ? { freeText } : {}),
        ...(sourceUser !== undefined ? { answeredBy: sourceUser } : {}),
      });
      if (!result.ok) {
        return reply(id, {
          content: [
            { type: "text", text: result.error ?? "submit_user_answer failed" },
          ],
          isError: true,
        });
      }
      const label = result.resolution?.label;
      const tail = label ? ` → ${label}` : freeText ? ` → "${freeText}"` : "";
      return reply(id, {
        content: [
          { type: "text", text: `Answer submitted: ${questionId}${tail}` },
        ],
      });
    }

    if (toolName === "submit_approval") {
      // #406 — Agent-routed approval relay. Validates approval id +
      // pending status, emits the resolution event so the in-flight
      // mediator request unblocks.
      // #526 — Optional `action_id` parameter for custom approval
      // buttons (e.g. "Block .env* reads from hermes"). When set,
      // Foreman both denies the current call AND injects a permanent
      // predicate-based deny rule derived from the approval's risk
      // factors. Plain decision: allow|deny still works for the
      // standard 4-action ladder.
      const args = params?.arguments ?? {};
      const rawApprovalId =
        typeof args.approval_id === "string" ? args.approval_id : "";
      const decision = args.decision;
      const remember = args.remember === true;
      const actionId =
        typeof args.action_id === "string" && args.action_id.length > 0
          ? args.action_id
          : undefined;
      if (!rawApprovalId) {
        return replyError(
          id,
          -32602,
          "submit_approval requires args.approval_id (string)",
        );
      }
      if (decision !== "allow" && decision !== "deny") {
        return replyError(
          id,
          -32602,
          "submit_approval requires args.decision: 'allow' | 'deny'",
        );
      }
      if (!services.approval.submitFromAgent) {
        return replyError(
          id,
          -32603,
          "submit_approval not supported by this Foreman build",
        );
      }
      // #552 PR 5 — Strip the visible `aprv_` prefix (added by the chat
      // surface so operators can distinguish Foreman approval ids from
      // agent session/thread ids) and classify the residual shape so a
      // "not found" reply can point the user at the right id source
      // instead of just saying "not found".
      const classification = classifyApprovalIdInput(rawApprovalId);
      const approvalId = classification.stripped;
      const result = await services.approval.submitFromAgent({
        approvalId,
        decision,
        remember,
        sourceAgent,
        actionId,
      });
      if (result.ok) {
        const tail = result.policyRuleId
          ? ` + policy rule #${result.policyRuleId} added`
          : remember
            ? " (remembered)"
            : "";
        return reply(id, {
          content: [
            {
              type: "text",
              text: `Submitted: ${approvalId} → ${decision}${tail}`,
            },
          ],
        });
      }
      // isError lets the agent's LLM see the message text and surface
      // it back to the user. PR 5 enriches the "not found" case with a
      // shape-aware hint so a user who pasted a codex thread id sees
      // "looks like a session id" instead of a flat "not found".
      const storeError = result.error ?? "submit_approval failed";
      const hint = approvalIdMissHint(classification);
      return reply(id, {
        content: [
          { type: "text", text: `${storeError}\n\n${hint}` },
        ],
        isError: true,
      });
    }

    if (toolName === "submit_command") {
      // #431 — Agent-routed orchestrator command. Same routing shape as
      // submit_approval: agent's chat consumer relays `/foreman <verb>`
      // text via this tool, we dispatch + return the reply for the
      // agent to post back.
      const args = params?.arguments ?? {};
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const argList = Array.isArray(args.args)
        ? args.args.filter((a): a is string => typeof a === "string")
        : [];
      const sourceUser =
        typeof args.source_user === "string" ? args.source_user : undefined;
      if (!command) {
        return replyError(
          id,
          -32602,
          "submit_command requires args.command (string)",
        );
      }
      const result = await services.commandRouter.dispatch(command, argList, {
        db: getDb(),
        registry: services.registry,
        llmConfigPath: services.llmConfigPath,
        configDir: services.configDir,
        sourceAgent,
        sourceUser,
        orchestratorChat: services.orchestratorChat ?? undefined,
        controlChannel: services.controlChannel,
        ownerStore: services.secretStore,
        secretStore: services.secretStore,
      });
      // #431 — Audit row per /foreman invocation. Persisted to
      // `audit_events` so the TUI Log page + `foreman log` CLI can
      // surface every orchestrator-routed command.
      services.audit.logEvent("foreman:command", {
        command,
        args: argList,
        sourceAgent,
        sourceUser: sourceUser ?? null,
        ok: result.ok,
        errorCode: result.errorCode ?? null,
      });
      return reply(id, {
        content: [{ type: "text", text: result.text }],
        isError: !result.ok,
      });
    }

    if (toolName === "submit_resolution") {
      // #527 — Agent-routed session resolution. The user tapped a
      // resolution button on a halt prompt; we hand the pick to the
      // SessionManager which flips state + enqueues a `write` row to
      // notify the participating agents.
      const args = params?.arguments ?? {};
      const sessionId =
        typeof args.session_id === "string" ? args.session_id : "";
      const optionId =
        typeof args.option_id === "string" ? args.option_id : "";
      const sourceUser =
        typeof args.source_user === "string" ? args.source_user : undefined;
      if (!sessionId) {
        return replyError(
          id,
          -32602,
          "submit_resolution requires args.session_id (string)",
        );
      }
      if (!optionId) {
        return replyError(
          id,
          -32602,
          "submit_resolution requires args.option_id (string)",
        );
      }
      if (!services.sessionManager) {
        return replyError(
          id,
          -32603,
          "submit_resolution not supported by this Foreman build (session manager not wired)",
        );
      }
      const option = services.sessionManager.provideResolution(
        sessionId,
        optionId,
        sourceUser ? { providedBy: sourceUser } : {},
      );
      if (!option) {
        return reply(id, {
          content: [
            {
              type: "text",
              text: `Unknown resolution option "${optionId}" for session ${sessionId} (either the session isn't waiting for a resolution, or the option id doesn't match what Foreman offered).`,
            },
          ],
          isError: true,
        });
      }
      services.audit.logEvent("session:resolved", {
        sessionId,
        optionId: option.id,
        payload: option.payload,
        sourceAgent,
        sourceUser: sourceUser ?? null,
      });
      return reply(id, {
        content: [
          {
            type: "text",
            text: `Resolution submitted: ${option.label}`,
          },
        ],
      });
    }

    if (toolName === "request_action_approval") {
      // #552 — Generic agent-action mediation entry point. Adapter
      // decodes the agent's wire payload, mediator runs risk + approval,
      // adapter encodes the resolved decision back. Fail-closed at every
      // step so a malformed payload or a mis-registered adapter cannot
      // silently let actions through.
      const args = params?.arguments ?? {};
      const adapterId =
        typeof args.adapter_id === "string" ? args.adapter_id : "";
      const wire = (args as { wire?: unknown }).wire;
      if (!adapterId) {
        return replyError(
          id,
          -32602,
          "request_action_approval requires args.adapter_id (string)",
        );
      }
      if (wire === undefined || wire === null) {
        return replyError(
          id,
          -32602,
          "request_action_approval requires args.wire (the adapter's native payload)",
        );
      }
      const adapter = getAdapter(adapterId);
      if (!adapter) {
        const known = listAdapterIds().join(", ");
        return replyError(
          id,
          -32602,
          `Unknown adapter '${adapterId}' (known: ${known})`,
        );
      }

      // Decode — fail-closed deny on any malformed payload. We still go
      // through the adapter's encodeDecision so the wire shape is correct
      // for the agent's transport. `approvalId: "unknown"` because we
      // don't have the agent's id yet — the adapter is allowed to use it
      // or ignore it.
      let normalised;
      try {
        normalised = adapter.decodeRequest(wire, sourceAgent);
      } catch (err) {
        const reason =
          err instanceof AdapterDecodeError
            ? err.message
            : err instanceof Error
              ? err.message
              : "adapter decode failure";
        const wireResp = adapter.encodeDecision(
          { kind: "deny", reason },
          "unknown",
        );
        return reply(id, {
          content: [
            {
              type: "text",
              text: `Denied (decode error): ${reason}`,
            },
          ],
          structuredContent: {
            decision: "deny",
            reason,
            wire: wireResp,
          },
          isError: true,
        });
      }

      // Route through the existing mediator. The synthetic JSON-RPC
      // message gives the mediator's `argsFromMessage` exactly what it
      // would have parsed from a real tools/call so risk + audit + LLM
      // verifier paths are unchanged.
      const mediatorResult = await services.mediator.handleRequest({
        sourceAgent: normalised.sourceAgent,
        targetTool: normalised.targetTool,
        sessionId: normalised.sessionId,
        message: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: normalised.targetTool,
            arguments: normalised.args,
          },
        } as JSONRPCMessage,
      });

      const decision: NormalisedDecision =
        mediatorResult.decision === "allowed"
          ? { kind: "allow" }
          : {
              kind: "deny",
              reason:
                mediatorResult.riskReasons?.[0] ??
                `denied by ${mediatorResult.decidedBy}`,
            };

      const wireResponse = adapter.encodeDecision(
        decision,
        normalised.approvalId,
      );

      return reply(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(wireResponse),
          },
        ],
        structuredContent: {
          decision: decision.kind === "allow" ? "allow" : "deny",
          reason: decision.kind === "deny" ? decision.reason : undefined,
          approval_id: mediatorResult.requestId,
          decided_by: mediatorResult.decidedBy,
          risk_score: mediatorResult.riskScore,
          risk_bucket: mediatorResult.riskBucket,
          wire: wireResponse,
        },
      });
    }

    const result = await services.mediator.handleRequest({
      sourceAgent,
      targetTool: toolName,
      message: msg,
    });
    if (result.decision === "allowed") {
      return reply(id, {
        content: [
          {
            type: "text",
            text: `(foreman) ${toolName ?? "request"} allowed by ${result.decidedBy}`,
          },
        ],
      });
    }
    return replyError(id, -32603, `Denied by ${result.decidedBy}`);
  }
  if (id !== undefined) {
    return replyError(id, -32601, `Method not found: ${method ?? "(unknown)"}`);
  }
  return null;
}

function reply(
  id: string | number | undefined,
  result: unknown,
): JSONRPCMessage | null {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result } as JSONRPCMessage;
}

function replyError(
  id: string | number | undefined,
  code: number,
  message: string,
): JSONRPCMessage | null {
  if (id === undefined) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  } as JSONRPCMessage;
}

export type { Services as McpStdioServices };
