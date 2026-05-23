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
import { MediatorService } from "../core/mediator.js";
import { OrchestratorChat } from "../core/orchestrator-chat.js";
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
            "Submit the user's decision on a pending Foreman approval. Call this when a user message in your chat is the literal slash command `/approve <id>`, `/approve_remember <id>`, `/deny <id>`, or `/deny_remember <id>`. The approval id comes from a Foreman notification message in the same chat. Pass `decision: \"allow\"` or `\"deny\"`, and `remember: true` only for the `_remember` variants. Do NOT call this on your own initiative — only when the user types the literal command.",
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
                  "User's choice — 'allow' permits the pending tool call; 'deny' blocks it.",
              },
              remember: {
                type: "boolean",
                description:
                  "When true, Foreman remembers this decision for the same source/target/tool combination and auto-resolves future identical calls.",
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

    if (toolName === "submit_approval") {
      // #406 — Agent-routed approval relay. Validates approval id +
      // pending status, emits the resolution event so the in-flight
      // mediator request unblocks.
      const args = params?.arguments ?? {};
      const approvalId =
        typeof args.approval_id === "string" ? args.approval_id : "";
      const decision = args.decision;
      const remember = args.remember === true;
      if (!approvalId) {
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
      const result = await services.approval.submitFromAgent({
        approvalId,
        decision,
        remember,
        sourceAgent,
      });
      if (result.ok) {
        return reply(id, {
          content: [
            {
              type: "text",
              text: `Submitted: ${approvalId} → ${decision}${remember ? " (remembered)" : ""}`,
            },
          ],
        });
      }
      // isError lets the agent's LLM see the message text and surface
      // it back to the user (e.g. "approval abc123 not found" → user
      // types the right id).
      return reply(id, {
        content: [
          { type: "text", text: result.error ?? "submit_approval failed" },
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
