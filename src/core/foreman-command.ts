import { existsSync } from "node:fs";
import { join } from "node:path";
import { isHumanSource, orgBudgetBlock, orgDelegationVerdict } from "./org/guard.js";
import { loadOrg, renderOrgLines, resolveAssignee, type OrgDoc } from "./org/org.js";
import { buildOrgReport, parsePeriod, renderOrgReport, resolveReportTarget } from "./usage/report.js";
import { BOSS, OrgComms, renderMessages } from "./org/comms.js";
import { FOREMAN_VERSION } from "../version.js";
import type { ForemanDb } from "../db/client.js";
import { DelegationTracker } from "./delegation-tracker.js";
import {
  ControlChannel,
  isOwner,
  type OwnerStore,
} from "./control-channel.js";
import { getBudgetStatus } from "./llm/budget.js";
import {
  defaultLlmConfig,
  isFeatureEnabled,
  loadLlmConfig,
  saveLlmConfig,
  setAuthMode,
  type LlmConfig,
} from "./llm/config.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  parseCallbackInput,
  type OAuthFetch,
  type OAuthTokens,
} from "./llm/oauth/oauth-flow.js";
import { generatePkce, generateState } from "./llm/oauth/pkce.js";
import {
  getOAuthProvider,
  isOAuthProviderId,
  type OAuthProviderId,
} from "./llm/oauth/oauth-providers.js";
import {
  loadOAuthTokens,
  saveOAuthTokens,
} from "./llm/oauth/token-store.js";
import { SecretNotFoundError } from "./secret-store.js";
import { loadActiveRegistry } from "./registry-catalog.js";
import { catalogEntryFor } from "./agent-instance.js";
import type { RegistryService } from "./registry.js";
import { clipForSurface, integrationChat, isIntegrationChange } from "./integrations/chat.js";
import type { ConfirmationStore } from "./integrations/confirmations.js";
import type { IntegrationService } from "./integrations/service.js";
import { providerModelTiers } from "./provider-resolver.js";
import type { SecretStore } from "./secret-store.js";

// =============================================================================
// Foreman command router (#431)
// =============================================================================
//
// User types `/foreman <verb> [args...]` into whichever agent's chat they
// have open. The agent's getUpdates consumer (sole consumer on the bot
// per yol C — see project_foreman_scope_yol_c.md) sees the literal slash
// command and routes it via the `submit_command` MCP tool. This router
// dispatches the verb to a built-in handler and returns a text reply
// the agent then posts back as a Telegram message.
//
// All handlers shipped in this PR are read-only — they execute fully
// inside the MCP-stdio process without needing cross-process signalling
// to `foreman start`. Cross-process commands (`stop`, `llm switch`,
// `write <agent>`) ship in follow-up issue #440.

export interface ForemanCommandContext {
  db: ForemanDb;
  registry: RegistryService;
  /** Path to `llm.yaml` so handlers can read the current Foreman LLM
   *  config + budget without hardcoding the location. */
  llmConfigPath: string;
  /** Foreman's `<configDir>` — useful for handlers that need to read
   *  or write sibling files (notify.yaml, foreman.pid, …). */
  configDir: string;
  /** #440 — Cross-process queue for state-mutating verbs. Optional so
   *  read-only verbs (status, help, llm status) still dispatch even
   *  when the channel hasn't been wired (e.g. in unit tests). */
  controlChannel?: ControlChannel;
  /** #440 — Secret store used by `isOwner` to gate mutating verbs.
   *  When omitted, every mutating verb is rejected (safe default). */
  ownerStore?: OwnerStore;
  /** Faz 4b / #512 — Full secret store used by read-only verbs that need
   *  to peek at OAuth token slots (e.g. `/foreman model` rendering whether
   *  the user is signed in to anthropic / openai). Distinct from
   *  `ownerStore` (which is the chat-id ownership check); the same
   *  `SecretStore` instance can be passed to both. When omitted, the
   *  OAuth-status section of `/foreman model` is skipped silently and
   *  `/foreman llm login` / `callback` reply with "not configured".  */
  secretStore?: SecretStore;
  /** Faz 4b / #512 — Optional fetch override for the OAuth token exchange
   *  in the chat-side `/foreman llm callback` handler. Production omits
   *  this (uses global fetch); tests inject a deterministic mock. */
  oauthFetch?: OAuthFetch;
  /** Agent id that routed the user's command (mirrors `submit_approval`
   *  pattern). Used for the audit log + future per-agent gating. */
  sourceAgent: string;
  /** Optional user identifier from the messaging platform (Telegram
   *  numeric user id, Discord snowflake, …) for audit traceability. */
  sourceUser?: string;
  /** The command comes from the person at the Foreman host itself (the
   *  TUI command bar), so the Telegram-id owner check does not apply.
   *  Only in-process owner surfaces set this; the MCP path never does,
   *  and nothing an agent sends can turn it on. */
  trustedOwner?: boolean;
  /** The owner allowed this exact command in a Foreman approval (#656): a
   *  command an agent relayed that changes Foreman. Satisfies the owner
   *  check that `source_user` used to (an agent can send any id it
   *  likes); org, budget and runaway checks still apply to the relaying
   *  agent. Only mcp-stdio sets it, and only after that approval. */
  ownerConfirmed?: boolean;
  /** Integrations (`/integrations`, `/integration …`). */
  integrations?: {
    service: IntegrationService;
    /** Chat remove codes; only `foreman start` keeps them. */
    confirmations?: ConfirmationStore;
    /** Told about changes made from chat (the inbox). */
    notice?: (title: string) => void;
  };
  /** An owner surface whose sender is not one of `owner_user_ids`
   *  (Slack / Discord) sets this to false: it may read integrations but
   *  not change them. Unset = the surface's own owner rule applies. */
  integrationOwner?: boolean;
  /** The relaying agent hands out work as itself (#656): `write`, `assign`
   *  and `<agent> <task>` from a verified agent are its delegation, not
   *  yours. No owner check and no owner attribution; the org chart,
   *  department budgets and the runaway guard decide, exactly as for
   *  `foreman write` run from a shell Foreman spawned for the agent. Only
   *  honoured for `write`. */
  agentDelegation?: boolean;
  /** Mediates a hand-off from `sourceAgent` to another agent before it is
   *  queued (#656): the call `sourceAgent → <target>:write` goes through
   *  policy.yaml (`agents.<id>.can_call` / `cannot_call`, `rules:` with an
   *  `<agent>:write` target), the risk engine and, when either asks, you.
   *  Set by the transports an agent delegates through; the owner surfaces
   *  leave it unset. */
  authorizeDelegation?: (
    targetAgent: string,
    task: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** #432 — Foreman's own LLM, gated on `features.orchestrator_chat`.
   *  When provided + enabled, `/foreman report me`, `/foreman <agent>
   *  ne yapıyor`, and unknown free-form verbs go through the LLM.
   *  Optional so the router stays usable without LLM credentials
   *  (read-only verbs still work). */
  orchestratorChat?: {
    isEnabled(): boolean;
    answer(input: {
      question: string;
      focusAgentId?: string;
    }): Promise<
      | { status: "ok"; text: string; costUsd: number; durationMs: number }
      | { status: "disabled"; reason: string }
      | { status: "budget_exceeded"; spentUsd: number; capUsd: number }
      | { status: "failed"; reason: string }
      | { status: "empty_response" }
    >;
  };
}

export interface ForemanCommandResult {
  ok: boolean;
  /** Not a command: the input went to Foreman's LLM as a question (#657).
   *  The TUI console says so, so free text isn't mistaken for a command. */
  answeredByLlm?: boolean;
  /** Text body to send back to the user. Multi-line is fine; channels
   *  fit ~4000 chars on Telegram, less on Discord. Keep replies tight. */
  text: string;
  /** Stable code for failures so callers can branch on category. */
  errorCode?:
    | "UNKNOWN_COMMAND"
    | "UNKNOWN_SUBCOMMAND"
    | "NOT_AUTHORIZED"
    | "NOT_AVAILABLE"
    // Runaway-loop guard fires: this agent has too many unresolved
    // delegations to the same target inside the runaway window.
    // Caller surfaces this as a hard stop, not a retry signal.
    | "RUNAWAY_LOOP"
    | "ORG_POLICY";
}

export type ForemanCommandHandler = (
  args: string[],
  ctx: ForemanCommandContext,
) => Promise<ForemanCommandResult> | ForemanCommandResult;

export class ForemanCommandRouter {
  private readonly handlers = new Map<string, ForemanCommandHandler>();
  private readonly descriptions = new Map<string, string>();

  register(
    verb: string,
    handler: ForemanCommandHandler,
    description: string,
  ): void {
    const key = verb.toLowerCase();
    this.handlers.set(key, handler);
    this.descriptions.set(key, description);
  }

  has(verb: string): boolean {
    return this.handlers.has(verb.toLowerCase());
  }

  listVerbs(): Array<{ verb: string; description: string }> {
    return [...this.descriptions.entries()].map(([verb, description]) => ({
      verb,
      description,
    }));
  }

  async dispatch(
    command: string,
    args: string[],
    ctx: ForemanCommandContext,
  ): Promise<ForemanCommandResult> {
    const handler = this.handlers.get(command.toLowerCase());
    if (handler) {
      return await handler(args, ctx);
    }
    // #524 — Free-form agent invocation. Before falling through to the
    // LLM, see if the first token names a registered agent. If so, treat
    // the rest of the message as a `write` directive. This lets users
    // type "OpenClaw, todo app yap" instead of `foreman write openclaw
    // todo app yap` — chat-native UX without losing the verb-based CLI.
    const lookup = ctx.registry.findByCommandToken(command);
    if (lookup.kind === "match") {
      const task = stripLeadingPunctuation(args.join(" ")).trim();
      if (task.length > 0) {
        // Delegate to the existing write handler so the success text +
        // queue/callable detection + owner gate stay in ONE place. The
        // user sees the same reply whether they typed `foreman write
        // openclaw foo` or `openclaw foo`. writeHandler joins
        // `args.slice(1)`, so passing the whole task as args[1]
        // preserves any internal whitespace verbatim.
        return await writeHandler([lookup.agent.id, task], ctx);
      }
      // First token matched an agent but there's no task body — fall
      // through to LLM so "openclaw" by itself becomes "ne yapıyor
      // openclaw?", not an awkward empty-task error.
    }
    // #432 — Free-form fallback. When the verb isn't registered but
    // Foreman LLM orchestrator chat is enabled, treat the whole input
    // (`<command> <args...>`) as a natural-language question. Agent id
    // detection: if the first token matches a registered agent, focus
    // the snapshot on it (`/foreman openclaw ne yapıyor`).
    if (ctx.orchestratorChat?.isEnabled()) {
      let question = [command, ...args].join(" ").trim();
      const maybeAgent = ctx.registry.get(command.toLowerCase());
      const focusAgentId = maybeAgent ? maybeAgent.id : undefined;
      // #524 — When two active agents collide on case-folded id or
      // displayName, prepend a disambiguation hint so the LLM can ask
      // the user to clarify instead of guessing. Rare in practice (the
      // wizard tries to prevent collisions on registration) but the
      // hint makes the surprise routing path obvious if it happens.
      if (lookup.kind === "ambiguous") {
        question =
          `Note: '${command}' could refer to agents ` +
          `[${lookup.candidates.join(", ")}]; ask the user to clarify.\n\n` +
          question;
      }
      const outcome = await ctx.orchestratorChat.answer({
        question,
        focusAgentId,
      });
      return { ...renderChatOutcome(outcome), answeredByLlm: true };
    }
    return {
      ok: false,
      text:
        `Unknown command "${command}". Try \`/foreman help\` for the list. ` +
        `(Enable \`features.orchestrator_chat\` in llm.yaml to make Foreman handle free-form questions.)`,
      errorCode: "UNKNOWN_COMMAND",
    };
  }
}

// =============================================================================
// What a relayed command may do on its own (#656)
// =============================================================================
//
// `submit_command` comes from an agent. It can relay what you typed in its
// chat, but it can't prove you typed it (`source_user` is whatever the
// agent sends). So:
//   - commands that only read run at once;
//   - handing out work (`write`, `assign`, `<agent> <task>`) runs as the
//     agent's own delegation, under the org chart, never as you;
//   - anything else that changes Foreman (stop, model or LLM changes,
//     sign-ins) runs only after you allow it in a Foreman approval.
// New verbs are "change" until listed here.

/** Verbs that only read state. `report` / free-form questions may spend
 *  Foreman's LLM budget, which has its own cap. */
const READ_VERBS: ReadonlySet<string> = new Set([
  "integrations",
  "help",
  "status",
  "agent",
  "agents",
  "activity",
  "org",
  "spend",
  "report",
]);

/** Owner-surface verbs refuse themselves unless `trustedOwner` is set
 *  (TUI, Slack, Discord), so there is nothing to confirm. */
const OWNER_SURFACE_VERBS: ReadonlySet<string> = new Set(["tell", "comms"]);

/** The tool a hand-off from one agent to another is mediated as (#656):
 *  policy targets it as `<agent>:write`. */
export const DELEGATION_TOOL = "write";

/** Verbs that hand work to another agent. */
const DELEGATION_VERBS: ReadonlySet<string> = new Set(["write", "assign"]);

export type RelayedCommandAccess = "read" | "delegate" | "change" | "owner-surface";

export function relayedCommandAccess(
  router: Pick<ForemanCommandRouter, "has">,
  registry: Pick<RegistryService, "findByCommandToken">,
  command: string,
  args: readonly string[],
): RelayedCommandAccess {
  const verb = command.trim().toLowerCase();
  if (READ_VERBS.has(verb)) return "read";
  if (OWNER_SURFACE_VERBS.has(verb)) return "owner-surface";
  if (DELEGATION_VERBS.has(verb)) return "delegate";
  if (verb === "llm") return (args[0] ?? "status").toLowerCase() === "status" ? "read" : "change";
  // Reading integrations is fine from a relay; changing them is yours only.
  if (verb === "integration") {
    return ["list", "status", "show"].includes((args[0] ?? "list").toLowerCase()) ? "read" : "owner-surface";
  }
  if (verb === "model" || verb === "models") return args.length === 0 ? "read" : "change";
  if (router.has(verb)) return "change";
  // Not a verb: `<agent> <task>` hands out work (a `write`); anything else
  // is a question for Foreman's LLM.
  const lookup = registry.findByCommandToken(command);
  const task = stripLeadingPunctuation(args.join(" ")).trim();
  return lookup.kind === "match" && task.length > 0 ? "delegate" : "read";
}

/** Plain text in a chat (no leading `/foreman`) is read as a command, but
 *  only to read: a report, a status, a question. A verb that changes
 *  Foreman or hands out work runs only when typed with `/foreman`, so a
 *  casual "stop" or "pause claude-code" never does. Returns the reply for
 *  plain text that would change something, else null. */
export function plainTextRefusal(
  router: Pick<ForemanCommandRouter, "has">,
  registry: Pick<RegistryService, "findByCommandToken">,
  command: string,
  args: readonly string[],
): string | null {
  if (relayedCommandAccess(router, registry, command, args) === "read") return null;
  const typed = [command, ...args].join(" ");
  return `That would change something, so I only run it as a command: send \`/foreman ${typed}\`.`;
}

// #524 — Strip a single run of leading punctuation right after the agent
// name so chat-native phrasing parses cleanly: "OpenClaw, todo app yap" →
// task "todo app yap"; "OpenClaw: build X" → "build X". Only the FIRST
// punctuation cluster after the name is stripped — punctuation in the
// middle of the task body stays intact.
function stripLeadingPunctuation(s: string): string {
  return s.replace(/^[\s,;:–—-]+/u, "");
}

// Translates the chat service's outcome variants into a uniform
// ForemanCommandResult. `disabled` / `budget_exceeded` / `failed` /
// `empty_response` are surfaced as `ok: false` so the agent's relay can
// flag them with `isError: true` to its LLM consumer.
function renderChatOutcome(
  outcome:
    | { status: "ok"; text: string; costUsd: number; durationMs: number }
    | { status: "disabled"; reason: string }
    | { status: "budget_exceeded"; spentUsd: number; capUsd: number }
    | { status: "failed"; reason: string }
    | { status: "empty_response" },
): ForemanCommandResult {
  if (outcome.status === "ok") {
    return { ok: true, text: outcome.text };
  }
  if (outcome.status === "disabled") {
    return {
      ok: false,
      text: outcome.reason,
      errorCode: "NOT_AVAILABLE",
    };
  }
  if (outcome.status === "budget_exceeded") {
    return {
      ok: false,
      text:
        `Foreman LLM budget exceeded: $${outcome.spentUsd.toFixed(2)} / $${outcome.capUsd.toFixed(2)}. ` +
        `Try again next billing window or bump the cap with \`foreman llm budget --set N\` on the host.`,
      errorCode: "NOT_AVAILABLE",
    };
  }
  if (outcome.status === "empty_response") {
    return {
      ok: false,
      text:
        "Foreman's LLM returned an empty response. Re-run the command — if it keeps happening, check `foreman llm budget` + the provider's status page.",
      errorCode: "NOT_AVAILABLE",
    };
  }
  return {
    ok: false,
    text: `Foreman LLM call failed: ${describeLlmFailure(outcome.reason)}`,
    errorCode: "NOT_AVAILABLE",
  };
}

/** "Anthropic fetch failed: fetch failed" said the same thing twice and
 *  nothing about what to do (#657). A network failure names the provider
 *  and the likely fix; anything else passes through. */
export function describeLlmFailure(reason: string): string {
  const network = /^(\w[\w ]*?) fetch failed: (.*)$/s.exec(reason);
  if (!network) return reason;
  const detail = network[2]!.trim();
  return (
    `couldn't reach ${network[1]}` +
    (detail && detail !== "fetch failed" ? ` (${detail})` : "") +
    ". Check the network connection, then try again (`foreman llm status` shows the provider)."
  );
}

// =============================================================================
// Built-in handlers
// =============================================================================

export function registerBuiltinCommands(router: ForemanCommandRouter): void {
  router.register(
    "help",
    (_args, _ctx) => buildHelpReply(router),
    "List every /foreman command + its purpose.",
  );
  router.register(
    "status",
    statusHandler,
    "One-line summary — registered agents, runtime status, Foreman build version.",
  );
  // QA round 15 — agents' LLMs reach for `/foreman agent` / `/foreman
  // agents` when asking "what's installed". Register both as aliases of
  // status so the call doesn't bounce off the unknown-command branch.
  router.register("agent", statusHandler, "Alias of `status`.");
  router.register("agents", statusHandler, "Alias of `status`.");
  router.register(
    "stop",
    stopHandler,
    "Gracefully shut down `foreman start` + every agent daemon it owns.",
  );
  router.register(
    "write",
    writeHandler,
    "Send a directive to an agent. Usage: `/foreman write <agent> <message>`.",
  );
  router.register(
    "report",
    reportHandler,
    "What a department, role or agent did and what it cost: `report marketing month`. `report me`: today's report, told by Foreman's LLM when it is on.",
  );
  router.register(
    "tell",
    tellHandler,
    "Post to a department, role, leadership or all-hands as you: `tell marketing ship the launch post Friday`.",
  );
  router.register(
    "comms",
    commsHandler,
    "Read your agents' conversations: `comms`, `comms marketing`, `comms leadership 50`.",
  );
  router.register(
    "spend",
    spendHandler,
    "Agent spend by department: `spend`, `spend marketing week` (today · week · month · 7d).",
  );
  router.register(
    "activity",
    activityHandler,
    "List recent /foreman directives + their status (no LLM required).",
  );
  router.register(
    "llm",
    llmSubrouterHandler,
    "Inspect / manage Foreman's own LLM. Try `/foreman llm status`.",
  );
  // #502 — User-facing shortcut for inspecting + switching models
  // across Foreman + every registered agent. Wraps `llm switch` for
  // Foreman's own brain and writes `agents.model_version` for
  // per-agent overrides (consumed by the spawn engine via
  // task_model_flag).
  router.register(
    "model",
    modelHandler,
    "Show / change model for Foreman or an agent. `/foreman model [<agent>] <model>`.",
  );
  router.register("models", modelHandler, "Alias of `model`.");
  router.register(
    "assign",
    assignHandler,
    "Give a task to a role, a department (its head) or an agent from org.yaml. `/foreman assign marketing <task>`.",
  );
  router.register("org", orgHandler, "Show the org chart (departments, roles, reporting lines).");
  router.register(
    "integrations",
    (_args, ctx) => integrationHandler(["list"], ctx),
    "List integrations (GitHub, GitLab, Jira, Trello, Linear, Notion).",
  );
  router.register(
    "integration",
    integrationHandler,
    "`integration status|enable|disable|remove <name>` — add and change them on the host.",
  );
}

function orgHandler(_args: string[], ctx: ForemanCommandContext): ForemanCommandResult {
  const org = loadOrgForCommand(ctx);
  if (!org.ok) return org.result;
  const registered = new Set(ctx.registry.list().map((a) => a.id.toLowerCase()));
  return { ok: true, text: renderOrgLines(org.doc, registered).join("\n") };
}

async function assignHandler(args: string[], ctx: ForemanCommandContext): Promise<ForemanCommandResult> {
  const target = args[0]?.trim();
  const task = args.slice(1).join(" ").trim();
  if (!target || !task) {
    return {
      ok: false,
      text: "Usage: `foreman assign <role|department|agent> <task>`. Example: `foreman assign marketing draft the launch post`.",
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  const org = loadOrgForCommand(ctx);
  if (!org.ok) return org.result;
  const roleId = resolveAssignee(org.doc, target);
  if (!roleId) {
    return {
      ok: false,
      text: `'${target}' is not a role, department or agent in org.yaml. Try \`foreman org\`.`,
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  const role = org.doc.roles[roleId]!;
  const result = await writeHandler([role.agent, task], ctx);
  return { ...result, text: `→ ${roleId} (${role.title}) · ${role.agent}\n${result.text}` };
}

function loadOrgForCommand(
  ctx: ForemanCommandContext,
): { ok: true; doc: OrgDoc } | { ok: false; result: ForemanCommandResult } {
  try {
    const doc = loadOrg(join(ctx.configDir, "org.yaml"));
    if (doc) return { ok: true, doc };
    return {
      ok: false,
      result: {
        ok: false,
        text: "No org chart yet. Create one with `foreman org init --template startup`.",
        errorCode: "NOT_AVAILABLE",
      },
    };
  } catch (err) {
    return {
      ok: false,
      result: {
        ok: false,
        text: `org.yaml is invalid: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: "NOT_AVAILABLE",
      },
    };
  }
}

const REPORT_DEFAULT_QUESTION_EN =
  "What have my agents been doing? Give me a quick status report.";
const REPORT_DEFAULT_QUESTION_TR =
  "Agent'lar ne yapıyor şu an? Kısa bir durum raporu ver.";

/** `report [target] [period]` / `spend [target] [period]` without an LLM:
 *  what a department, role or agent did and what it cost (#629). Returns
 *  null when the words don't name a target or a period. */
function orgReport(args: string[], ctx: ForemanCommandContext, fallbackToCompany: boolean): ForemanCommandResult | null {
  let org: OrgDoc | null = null;
  try {
    org = loadOrg(join(ctx.configDir, "org.yaml"));
  } catch {
    org = null;
  }
  const all = args.map((a) => a.toLowerCase());
  // `report me …` and anything longer than "<target> <period>" is a
  // question for Foreman's LLM, when it's on.
  const asksLlm = all.some((a) => a === "me" || a === "ben");
  const words = all.filter((a) => a !== "me" && a !== "ben");
  const periodWord = words.find((w) => parsePeriod(w) !== null);
  const targetWord = words.find((w) => w !== periodWord);
  const extra = words.filter((w) => w !== periodWord && w !== targetWord);
  if (!fallbackToCompany && ctx.orchestratorChat?.isEnabled() && (asksLlm || extra.length > 0)) return null;
  const knownAgents = ctx.registry.list().map((a) => a.id.toLowerCase());
  const target = resolveReportTarget(org, targetWord, knownAgents);
  if (!target) {
    if (!fallbackToCompany) return null;
    const names = org ? [...Object.keys(org.departments), ...Object.keys(org.roles)] : knownAgents;
    return {
      ok: false,
      text: `No department, role or agent called '${targetWord}'. Try one of: ${names.slice(0, 12).join(", ") || "(none yet)"}.`,
    };
  }
  if (!targetWord && !periodWord && !fallbackToCompany) return null;
  const period = parsePeriod(periodWord)!;
  // Task output excerpts are for you, not for an agent asking through chat.
  const report = buildOrgReport(ctx.db, org, target, period, Date.now(), ctx.trustedOwner === true);
  return { ok: true, text: renderOrgReport(report) };
}

// Department channels (#630). Reading every channel and posting as you are
// owner actions, available only where Foreman knows it is you: the TUI, the
// CLI, and `/foreman` from Slack / Discord allowed users. The relayed chat
// path can't prove that, so it doesn't get them.
function ownerOnly(verb: string): ForemanCommandResult {
  return {
    ok: false,
    text: `\`${verb}\` is for you only: use the TUI console, \`foreman org ${verb === "comms" ? "messages" : verb}\`, or /foreman in two-way Slack or Discord.`,
    errorCode: "NOT_AUTHORIZED",
  };
}

async function integrationHandler(args: string[], ctx: ForemanCommandContext): Promise<ForemanCommandResult> {
  const surface = ctx.sourceAgent;
  const owner = ctx.trustedOwner === true && ctx.integrationOwner !== false;
  const text = clipForSurface(
    await integrationChat(args, {
      service: ctx.integrations?.service ?? null,
      confirmations: ctx.integrations?.confirmations ?? null,
      surface,
      user: (ctx.sourceUser ?? "").replace(/^[a-z]+:/, ""),
      owner,
      ...(ctx.integrations?.notice ? { notice: ctx.integrations.notice } : {}),
    }),
    surface,
  );
  // A change refused for want of an owner is a refusal, in the audit log
  // (`foreman:command` ok=false) and to a relaying agent (isError).
  if (!owner && ctx.integrations && isIntegrationChange(args)) {
    return { ok: false, text, errorCode: "NOT_AUTHORIZED" };
  }
  return { ok: true, text };
}

function tellHandler(args: string[], ctx: ForemanCommandContext): ForemanCommandResult {
  if (!ctx.trustedOwner) return ownerOnly("tell");
  const [to, ...rest] = args;
  const text = rest.join(" ").trim();
  if (!to || !text) {
    return { ok: false, text: "Usage: `tell <department|role|leadership|all> <message>`" };
  }
  const comms = new OrgComms(ctx.db, { orgConfigPath: join(ctx.configDir, "org.yaml") });
  const result = comms.post({
    from: BOSS,
    asOwner: true,
    to,
    text,
    kind: to.toLowerCase() === "all" ? "announcement" : "message",
  });
  if (!result.ok) return { ok: false, text: result.reason };
  return { ok: true, text: `Posted to ${result.label}. Agents there read it with org_read.` };
}

function commsHandler(args: string[], ctx: ForemanCommandContext): ForemanCommandResult {
  if (!ctx.trustedOwner) return ownerOnly("comms");
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const channel = args.find((a) => a !== limitArg);
  const comms = new OrgComms(ctx.db, { orgConfigPath: join(ctx.configDir, "org.yaml") });
  const problem = channel ? comms.readError({ viewer: BOSS, asOwner: true, channel }) : null;
  if (problem) return { ok: false, text: problem };
  const messages = comms.read({
    viewer: BOSS,
    asOwner: true,
    ...(channel ? { channel } : {}),
    limit: limitArg ? Number(limitArg) : 20,
  });
  return { ok: true, text: renderMessages(messages) };
}

function spendHandler(args: string[], ctx: ForemanCommandContext): ForemanCommandResult {
  return orgReport(args, ctx, true)!;
}

function reportHandler(
  args: string[],
  ctx: ForemanCommandContext,
): Promise<ForemanCommandResult> | ForemanCommandResult {
  // `report marketing month`, `report codex today`: the org report, no LLM.
  const deterministic = orgReport(args, ctx, false);
  if (deterministic) return deterministic;
  // `report`, `report me` (`ben`): the default question. Anything else is
  // the question itself.
  const trailing = args.join(" ").trim();
  const isMeOrEmpty = trailing.length === 0 || ["me", "ben"].includes(trailing.toLowerCase());
  // Without Foreman's LLM (off, not wired here, over budget, failing) the
  // default question still gets today's company report, never an error.
  if (isMeOrEmpty && !ctx.orchestratorChat?.isEnabled()) return orgReport([], ctx, true)!;
  if (!ctx.orchestratorChat) {
    return {
      ok: false,
      text:
        "Orchestrator chat isn't wired in this process — questions need Foreman LLM. " +
        "Run `foreman llm enable orchestrator_chat` on the host, or ask for `report`.",
      errorCode: "NOT_AVAILABLE",
    };
  }
  if (!ctx.orchestratorChat.isEnabled()) {
    return {
      ok: false,
      text:
        "Foreman LLM orchestrator chat is off. " +
        "Enable it via `foreman llm enable orchestrator_chat` on the host, or ask for `report`.",
      errorCode: "NOT_AVAILABLE",
    };
  }
  const language = detectLanguageFromArgs(args);
  const question = isMeOrEmpty
    ? language === "tr"
      ? REPORT_DEFAULT_QUESTION_TR
      : REPORT_DEFAULT_QUESTION_EN
    : trailing;
  return ctx.orchestratorChat.answer({ question }).then((outcome) => {
    if (outcome.status === "ok" || !isMeOrEmpty) return renderChatOutcome(outcome);
    const fallback = orgReport([], ctx, true)!;
    return { ...fallback, text: `${fallback.text}\n\n(${renderChatOutcome(outcome).text})` };
  });
}

// `/foreman activity` — non-LLM view of recent control_commands rows so
// the user can answer "what did I tell Foreman lately and did it land?"
// without enabling orchestrator_chat. Limit is small on purpose (10);
// for longer history the LLM-narrated `/foreman report` is the path.
function activityHandler(
  args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  if (!ctx.controlChannel) {
    return {
      ok: false,
      text:
        "`/foreman activity` needs the cross-process control channel — not wired in this process. " +
        "Run the command on the Foreman host CLI instead.",
      errorCode: "NOT_AVAILABLE",
    };
  }
  const limitArg = Number(args[0]);
  const limit =
    Number.isFinite(limitArg) && limitArg >= 1 && limitArg <= 50
      ? Math.floor(limitArg)
      : 10;
  const rows = ctx.controlChannel.recent(limit);
  if (rows.length === 0) {
    return {
      ok: true,
      text:
        "No /foreman directives have been issued yet. Try " +
        "`foreman write <agent> <task>` or `foreman llm switch <provider> <model>`.",
    };
  }
  const now = Date.now();
  const lines: string[] = [`Recent directives (last ${rows.length}):`];
  for (const row of rows) {
    const ageMs = now - row.createdAt;
    const status =
      row.status === "applied"
        ? "✓"
        : row.status === "failed"
          ? "✗"
          : row.status === "rejected"
            ? "⊘"
            : "…";
    const parsedArgs = parseArgsJson(row.args);
    const summary = summarizeCommand(row.command, parsedArgs);
    lines.push(`  ${status} ${summary} — ${describeAgo(ageMs)} (id=${row.id})`);
  }
  return { ok: true, text: lines.join("\n") };
}

function parseArgsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function summarizeCommand(command: string, args: string[]): string {
  if (command === "write") {
    const target = args[0] ?? "?";
    const body = args.slice(1).join(" ");
    const preview =
      body.length > 60 ? `${body.slice(0, 57)}…` : body;
    return `write ${target}: ${preview}`;
  }
  if (command === "llm-switch") {
    return `llm switch ${args.join(" ")}`.trim();
  }
  if (command === "llm-budget") {
    return `llm budget ${args.join(" ")}`.trim();
  }
  if (command === "stop") return "stop";
  return `${command} ${args.join(" ")}`.trim();
}

// #502 — `/foreman model` — three modes by arg count:
//   - 0 args: status table (Foreman LLM + every registered agent)
//   - 1 arg:  switch Foreman's own LLM model, keeping current provider
//   - 2 args: first arg is either a provider id (then it's a Foreman
//     LLM provider+model switch) or an agent id (then it's a per-agent
//     override). Providers and agent ids don't overlap in practice
//     (openai/anthropic/... vs codex/claude-code/hermes/...).
const KNOWN_PROVIDER_IDS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "openai_compatible",
]);

function modelHandler(
  args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  // Mode 1 — status
  if (args.length === 0) {
    return modelStatusReply(ctx);
  }
  // Mode 2 — single arg, Foreman LLM model only
  if (args.length === 1) {
    return enqueueForemanLlmSwitch(ctx, undefined, args[0]!);
  }
  // Mode 3 — two args. Disambiguate by first token.
  const first = args[0]!.toLowerCase();
  if (KNOWN_PROVIDER_IDS.has(first)) {
    return enqueueForemanLlmSwitch(ctx, first, args[1]!);
  }
  // Treat as agent override.
  return setAgentModel(ctx, first, args.slice(1).join(" "));
}

// Curated "quick switch" model lists per provider. Annotated with a
// one-word price hint so users skim cost trade-offs without leaving
// chat. Telegram renders backticked text as inline code → long-press
// on mobile triggers a copy menu, which is the closest we get to an
// inline-keyboard model picker without owning the bot.
/** Tap-to-copy model ids per provider, from registry/providers.json's
 *  model_tiers (a new model generation is a registry change). */
function quickModels(provider: string): Array<{ id: string; hint: string }> {
  const tiers = providerModelTiers(provider);
  if (!tiers) return [];
  return [
    { id: tiers.fast, hint: "fast, cheapest" },
    { id: tiers.balanced, hint: "balanced" },
    { id: tiers.strongest, hint: "most capable" },
  ];
}

// Maps each registry agent id → which provider's quick-switch list to
// surface. Today only callable agents (codex / claude-code) need
// this; daemon-style agents (Hermes, OpenClaw) don't have a
// task_model_flag so the override would be a no-op.
const AGENT_PROVIDER: Record<string, string> = {
  codex: "openai",
  "claude-code": "anthropic",
};

// Providers for which Foreman supports subscription sign-in (alongside
// API-key auth). Mirrors the OAuth catalog in `oauth-providers.ts` — kept as
// a local literal so this file doesn't reach across the LLM module just to
// enumerate them.
const OAUTH_CAPABLE: readonly OAuthProviderId[] = ["anthropic", "openai"];

/** Push an `Auth:` block onto `lines` describing how each OAuth-capable
 *  provider is currently authenticating. Mirrors the `foreman llm status`
 *  CLI output so Telegram users see the same picture without leaving chat. */
function appendAuthLines(
  lines: string[],
  cfg: LlmConfig,
  store: SecretStore,
): void {
  const rows: string[] = [];
  for (const pid of OAUTH_CAPABLE) {
    const cred = cfg.credentials[pid];
    if (cred?.auth_mode === "oauth") {
      const tokens = loadOAuthTokens(store, pid);
      if (tokens) {
        const account = tokens.accountId ? ` · ${tokens.accountId}` : "";
        rows.push(`  ${pid} — OAuth (signed in${account})`);
      } else {
        rows.push(
          `  ${pid} — OAuth (not signed in) → \`foreman llm login ${pid}\``,
        );
      }
    } else {
      const slot = cred?.secret_name ? ` (\`${cred.secret_name}\`)` : "";
      rows.push(`  ${pid} — api key${slot}`);
    }
  }
  if (rows.length === 0) return;
  lines.push("");
  lines.push("Auth:");
  for (const row of rows) lines.push(row);
}

function modelStatusReply(ctx: ForemanCommandContext): ForemanCommandResult {
  const lines: string[] = [];
  // Foreman's own LLM
  let currentForemanProvider: string | null = null;
  let cfg: LlmConfig | null = null;
  try {
    cfg = existsSync(ctx.llmConfigPath)
      ? loadLlmConfig(ctx.llmConfigPath)
      : defaultLlmConfig();
    const enabled = cfg.enabled ? "on" : "off";
    currentForemanProvider = cfg.provider;
    lines.push(
      `Foreman LLM (${enabled}): \`${cfg.provider}\` · \`${cfg.model}\``,
    );
  } catch {
    lines.push("Foreman LLM: (could not read llm.yaml)");
  }
  // Per-agent (current state)
  const agents = ctx.registry.listAll();
  const overridableAgents: string[] = [];
  if (agents.length > 0) {
    lines.push("");
    lines.push("Agents:");
    for (const a of agents) {
      const override = a.modelVersion ? `\`${a.modelVersion}\`` : "(agent default)";
      lines.push(`  ${a.id} — ${override}`);
      if (AGENT_PROVIDER[a.id]) overridableAgents.push(a.id);
    }
  }
  // OAuth / API-key auth state per provider (#512 / Faz 4b). Skipped silently
  // when no secretStore was wired into ctx (test ergonomics — keeps existing
  // tests untouched and works without a master key on disk).
  if (cfg && ctx.secretStore) {
    appendAuthLines(lines, cfg, ctx.secretStore);
  }
  // Tap-to-copy quick switches for Foreman LLM
  if (currentForemanProvider) {
    const models = quickModels(currentForemanProvider);
    if (models && models.length > 0) {
      lines.push("");
      lines.push(`Tap to switch Foreman LLM (keeping ${currentForemanProvider}):`);
      for (const m of models) {
        lines.push(`  \`foreman model ${m.id}\` — ${m.hint}`);
      }
    }
  }
  // Quick switches per overridable agent (codex / claude-code)
  for (const agentId of overridableAgents) {
    const providerForAgent = AGENT_PROVIDER[agentId];
    if (!providerForAgent) continue;
    const models = quickModels(providerForAgent);
    if (!models || models.length === 0) continue;
    lines.push("");
    lines.push(`Tap to switch ${agentId} (${providerForAgent}):`);
    for (const m of models) {
      lines.push(`  \`foreman model ${agentId} ${m.id}\` — ${m.hint}`);
    }
    lines.push(`  \`foreman model ${agentId} clear\` — back to default`);
  }
  // Manual form (kept for power users / agents without quick-list support)
  lines.push("");
  lines.push("Custom form:");
  lines.push("  `foreman model <new-model>`              (Foreman LLM)");
  lines.push("  `foreman model <provider> <new-model>`   (Foreman LLM, switch provider too)");
  lines.push("  `foreman model <agent-id> <new-model>`   (per-agent override)");
  return { ok: true, text: lines.join("\n") };
}

function enqueueForemanLlmSwitch(
  ctx: ForemanCommandContext,
  providerOverride: string | undefined,
  model: string,
): ForemanCommandResult {
  // Reuse the existing llm-switch enqueue path so the drain handler
  // applies + persists the change exactly as it would for
  // `/foreman llm switch <provider> <model>`.
  let provider = providerOverride;
  if (!provider) {
    // Single-arg form: keep current provider, just swap the model id.
    try {
      const cfg = existsSync(ctx.llmConfigPath)
        ? loadLlmConfig(ctx.llmConfigPath)
        : defaultLlmConfig();
      provider = cfg.provider;
    } catch {
      return {
        ok: false,
        text:
          "Couldn't read current Foreman LLM config. Specify the provider explicitly: " +
          "`/foreman model <provider> <model>`.",
        errorCode: "NOT_AVAILABLE",
      };
    }
  }
  return enqueueMutating(ctx, "llm-switch", [provider!, model], {
    successText: `Foreman LLM switching to ${provider} · ${model}.`,
  });
}

function setAgentModel(
  ctx: ForemanCommandContext,
  agentId: string,
  model: string,
): ForemanCommandResult {
  if (!ctx.registry.get(agentId)) {
    return {
      ok: false,
      text:
        `No agent registered with id "${agentId}". Try \`/foreman status\` ` +
        `or pick one of: ${ctx.registry
          .listAll()
          .map((a) => a.id)
          .join(", ")}.`,
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  const normalized = model.trim();
  if (normalized.length === 0) {
    return {
      ok: false,
      text:
        "Usage: `/foreman model <agent-id> <model>`. " +
        "Example: `/foreman model codex gpt-5-mini`. " +
        "Pass `clear` as the model to remove the override.",
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  // Owner-gated like other mutating verbs. Reuse enqueueMutating to get
  // the source_user fallback + audit row consistently.
  const value = normalized.toLowerCase() === "clear" ? "" : normalized;
  return enqueueMutating(
    ctx,
    "agent-model",
    [agentId, value],
    {
      successText:
        value === ""
          ? `Cleared model override for ${agentId} — future spawns use its default.`
          : `Setting ${agentId} model to ${value} for future spawns.`,
    },
  );
}

function detectLanguageFromArgs(args: string[]): "en" | "tr" {
  const joined = args.join(" ").toLowerCase();
  if (
    joined.includes("ne yap") ||
    joined.includes("ne ol") ||
    joined.includes("napı") ||
    joined.includes("durum")
  ) {
    return "tr";
  }
  return "en";
}

function buildHelpReply(router: ForemanCommandRouter): ForemanCommandResult {
  const lines: string[] = ["Foreman commands:"];
  for (const v of router.listVerbs()) {
    lines.push(`  /foreman ${v.verb.padEnd(8)}  ${v.description}`);
  }
  lines.push("");
  lines.push("(case-insensitive — anything not in this list returns an error.)");
  return { ok: true, text: lines.join("\n") };
}

function statusHandler(
  _args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const agents = ctx.registry.listAll();
  const active = agents.filter((a) => a.status === "active").length;
  const blocked = agents.filter((a) => a.status === "blocked").length;
  const disabled = agents.filter((a) => a.status === "disabled").length;
  const lines: string[] = [
    `Foreman v${FOREMAN_VERSION} — ${agents.length} agent${agents.length === 1 ? "" : "s"} registered`,
    `  ${active} active · ${blocked} blocked · ${disabled} disabled`,
  ];
  if (agents.length > 0) {
    lines.push("");
    lines.push("Agents:");
    for (const a of agents.slice(0, 10)) {
      const flag =
        a.status === "active"
          ? "●"
          : a.status === "blocked"
            ? "✗"
            : a.status === "disabled"
              ? "○"
              : "·";
      const lastSeen = a.lastSeenAt
        ? `last ${describeAgo(Date.now() - a.lastSeenAt)}`
        : "never";
      lines.push(`  ${flag} ${a.id} — ${lastSeen}`);
    }
    if (agents.length > 10) lines.push(`  … and ${agents.length - 10} more`);
  }
  return { ok: true, text: lines.join("\n") };
}

function stopHandler(
  _args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  return enqueueMutating(ctx, "stop", [], {
    successText:
      "Shutdown queued. Foreman start will exit + agent daemons SIGTERM within ~2s.",
  });
}

// #433 — `/foreman write <agent> <message...>`. Owner-gated, queued
// for the start-side drain handler to deliver via Telegram + optional
// inbound_dir file write. Returns the queued id; user sees the
// formatted Foreman → <agent> post in their chat ~1.5s later.
async function writeHandler(
  args: string[],
  ctx: ForemanCommandContext,
): Promise<ForemanCommandResult> {
  const targetAgent = args[0]?.toLowerCase().trim();
  const message = args.slice(1).join(" ").trim();
  if (!targetAgent || !message) {
    return {
      ok: false,
      text:
        "Usage: `foreman write <agent> <message>`. " +
        "Example: `foreman write openclaw pause your current task and focus on Y`.",
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  const target = ctx.registry.get(targetAgent);
  if (!target) {
    return {
      ok: false,
      text:
        `Unknown agent "${targetAgent}". Run \`foreman status\` for the list of registered agents.`,
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  // QA round 10: catch the self-target case where the user types
  // `foreman write hermes hello` *from inside the Hermes chat*. The
  // current "Directive queued" reply is technically correct but
  // useless — the agent is ALREADY this chat; the user just needs
  // to say what they want directly. Without this guard, users
  // think Foreman is broken when their message goes into a queue
  // they can't see.
  if (
    ctx.sourceAgent &&
    targetAgent === ctx.sourceAgent.toLowerCase().trim()
  ) {
    return {
      ok: false,
      text:
        `You're already talking to **${ctx.sourceAgent}** in this chat — ` +
        `\`foreman write ${targetAgent} ...\` is for sending directives to ` +
        `OTHER agents. To say "${message}" to ${ctx.sourceAgent}, just type ` +
        `it directly (without the \`foreman write\` prefix).`,
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  // Foreman Org — delegation follows the reporting lines in org.yaml.
  const orgVerdict = orgDelegationVerdict(
    join(ctx.configDir, "org.yaml"),
    ctx.sourceAgent?.toLowerCase().trim(),
    targetAgent,
  );
  if (orgVerdict && !orgVerdict.allowed) {
    return {
      ok: false,
      text:
        `Blocked by the org chart: ${orgVerdict.reason}. ` +
        "Hand the task to your manager (or a department head) instead, or ask the user to assign it.",
      errorCode: "ORG_POLICY",
    };
  }
  // Department budgets (#629): with `on_exceed: pause`, agents can't hand
  // new work into a department that has spent its budget. The owner can.
  if (!ctx.trustedOwner && !isHumanSource(ctx.sourceAgent)) {
    const overBudget = orgBudgetBlock(ctx.db, join(ctx.configDir, "org.yaml"), targetAgent);
    if (overBudget) {
      return {
        ok: false,
        text: `Paused by budget: ${overBudget}. Ask the user to raise it (foreman org budget) or wait for the period to reset.`,
        errorCode: "ORG_POLICY",
      };
    }
  }
  // Runaway-loop guard. When an LLM-driven agent (or even the user
  // via CLI) keeps firing delegations to the same target without
  // closing earlier ones, the chain is likely stuck. Block the new
  // directive so the operator gets a clear "stop and think" signal
  // instead of a runaway token bill.
  //
  // Skip for sourceAgent='cli' (terminal user issuing back-to-back
  // commands by hand is fine — they see each result) and for
  // initiators that don't have a sourceAgent (rare path, but it
  // means there's no chain context to evaluate).
  // The TUI owner surface counts as the terminal user too.
  if (ctx.sourceAgent && ctx.sourceAgent.toLowerCase() !== "cli" && !ctx.trustedOwner) {
    try {
      const tracker = new DelegationTracker({ db: ctx.db });
      const check = tracker.checkRunawayLoop(ctx.sourceAgent, targetAgent);
      if (!check.ok) {
        return {
          ok: false,
          text: check.reason,
          errorCode: "RUNAWAY_LOOP",
        };
      }
    } catch (err) {
      // Tracker failures must not break legitimate writes. Log to
      // stderr + let the directive through; PR A's watchdog catches
      // the eventual stall anyway.
      process.stderr.write(
        `foreman: runaway check failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  // The hand-off itself is a call from one agent to another (#656):
  // `can_call` / `cannot_call` and `<agent>:write` rules apply to it.
  if (ctx.authorizeDelegation && !ctx.trustedOwner && !ctx.ownerConfirmed && !isHumanSource(ctx.sourceAgent)) {
    const verdict = await ctx.authorizeDelegation(targetAgent, message);
    if (!verdict.ok) {
      return {
        ok: false,
        text: `Not handed to ${targetAgent}: ${verdict.reason}.`,
        errorCode: "ORG_POLICY",
      };
    }
  }

  // PR D — when the target agent declares task_command_template,
  // the drain handler will spawn it and post the output back to chat.
  // Tailor the success text so users know to wait for the follow-up
  // rather than thinking they need to forward the directive manually.
  // target (RegisteredAgent) is the DB row; task_command_template
  // lives on the catalog entry. Best-effort lookup — if registry
  // can't be loaded (corrupt JSON, etc.) we treat as non-callable
  // and the queue+relay path runs as before.
  let isCallable = false;
  try {
    const catalog = loadActiveRegistry();
    // An instance (`backend --type codex`) is callable as its type.
    const entry = catalogEntryFor(catalog.doc, targetAgent, ctx.registry.get(targetAgent));
    // #445 / #552 — ACP agents (Hermes/OpenClaw/ZeroClaw with
    // `approval_adapter='acp-stdio-v1'` + `acp_command`) are also
    // callable: the drain handler spawns them via `runAcpMediatedTask`.
    // Without this branch the success text falsely says "Directive
    // queued" even though we DO auto-execute them.
    isCallable = Boolean(
      entry?.task_command_template ||
        (entry?.approval_adapter === "acp-stdio-v1" && entry?.acp_command),
    );
  } catch {
    isCallable = false;
  }
  // The TUI has no chat thread; results land in its Activity feed + inbox.
  const where = ctx.trustedOwner ? "in the Activity feed and your inbox" : "in this chat";
  const successText = isCallable
    ? `Spawning ${targetAgent} with your task — output will arrive ${where} when the agent finishes.`
    : `Directive queued for ${targetAgent}. ` +
      `${targetAgent} doesn't declare a non-interactive command, so the ` +
      `directive is posted in chat for you to forward (and dropped in ` +
      `\`inbound_dir\` if configured). To enable auto-execution, add ` +
      `\`task_command_template\` to ${targetAgent}'s registry entry.`;
  return enqueueMutating(ctx, "write", [targetAgent, message], {
    successText,
    // For callable agents the success line already explains what's about
    // to happen ("Spawning … output will arrive"). Tacking on a tracking
    // id reads like the task is stuck in a queue — confusing. Skip it.
    // For non-callable (relay) targets we keep the id, since the user
    // may need it to reference the queued directive later.
    includeQueueId: !isCallable,
  });
}

// #440 — Shared scaffolding for every state-mutating verb. Verifies
// the control channel is wired + the user is the owner, enqueues the
// command, and returns a uniform "queued" reply that includes the row
// id (handy for cross-referencing the audit log).
function enqueueMutating(
  ctx: ForemanCommandContext,
  command: string,
  args: string[],
  opts: { successText: string; includeQueueId?: boolean },
): ForemanCommandResult {
  if (!ctx.controlChannel) {
    return {
      ok: false,
      text:
        `\`/foreman ${command}\` needs the cross-process control channel — not wired in this process. ` +
        `Run the command on the Foreman host CLI instead.`,
      errorCode: "NOT_AVAILABLE",
    };
  }
  // QA round 13 — when the agent's LLM forgets to pass source_user on
  // the MCP call (intermittent, common), Foreman previously bailed with
  // NOT_AUTHORIZED. Net result: legit owner randomly denied based on
  // LLM behavior. Now we use a deterministic fallback: if source_user
  // is missing AND telegram-chat-id is configured, treat the request
  // as coming from the configured owner. Safe for 1:1 Telegram chats
  // (the common case) because only the owner can DM the bot anyway.
  // For group chats this would be too permissive — but Foreman v0.1
  // doesn't support multi-user installs.
  //
  // QA round 17 — extended: agents sometimes pass DISPLAY NAME (e.g.
  // "Isa") instead of the numeric Telegram user id. Telegram user
  // ids are always numeric, so a non-numeric source_user is by
  // definition wrong. Treat it the same as missing — fall back to
  // telegram-chat-id rather than rejecting with NOT_AUTHORIZED.
  // The TUI command bar is the owner at the host: no Telegram id to check.
  // A relayed command you allowed in Foreman (#656) is yours too; the
  // agent's `source_user` is not trusted for attribution.
  // An agent's own delegation (#656) needs no owner and claims none.
  const delegation = command === "write" && ctx.agentDelegation === true && !ctx.trustedOwner;
  let effectiveSourceUser = ctx.trustedOwner
    ? (ctx.sourceUser ?? "owner")
    : ctx.ownerConfirmed
      ? ownerIdOr(ctx.ownerStore, "owner")
      : delegation
        ? undefined
        : ctx.sourceUser;
  const ownerChecked = ctx.trustedOwner === true || ctx.ownerConfirmed === true || delegation;
  const isNumericUserId = (s: string | undefined): s is string =>
    typeof s === "string" && s.trim().length > 0 && /^\d+$/.test(s.trim());
  if (
    !ownerChecked &&
    !isNumericUserId(effectiveSourceUser) &&
    ctx.ownerStore?.exists("telegram-chat-id")
  ) {
    try {
      effectiveSourceUser = ctx.ownerStore.get("telegram-chat-id");
    } catch {
      /* fall through to the missing-user error below */
    }
  }
  if (
    !ownerChecked &&
    (!ctx.ownerStore || !isOwner(ctx.ownerStore, { sourceUser: effectiveSourceUser }))
  ) {
    // QA round 10: distinguish "no source_user was sent" (agent's LLM
    // forgot to include it AND no telegram-chat-id fallback worked)
    // from "source_user sent but doesn't match telegram-chat-id".
    const missingSourceUser =
      !effectiveSourceUser || effectiveSourceUser.trim().length === 0;
    if (missingSourceUser) {
      return {
        ok: false,
        text:
          `\`foreman ${command}\` needs your Telegram user id to verify ` +
          `ownership, but the agent didn't pass it and no \`telegram-chat-id\` ` +
          `is configured to fall back on. Configure with ` +
          `\`foreman secrets add telegram-chat-id\` (paste your Telegram user id).`,
        errorCode: "NOT_AUTHORIZED",
      };
    }
    return {
      ok: false,
      text:
        `\`foreman ${command}\` is owner-only. Your Telegram user id ` +
        `(${effectiveSourceUser}) doesn't match the configured \`telegram-chat-id\`. ` +
        `Fix: run \`foreman secrets rotate telegram-chat-id\` and paste your ` +
        `current user id, or contact the host owner.`,
      errorCode: "NOT_AUTHORIZED",
    };
  }
  const enq = ctx.controlChannel.enqueue({
    command,
    args,
    sourceAgent: ctx.sourceAgent,
    // Use the resolved value (may be the telegram-chat-id fallback)
    // so the drain handler sees a consistent user id for audit/relay.
    sourceUser: effectiveSourceUser,
  });
  // "tracking id" rather than "queued id" — the latter reads like the
  // request is stuck waiting, but in practice the drain handler picks
  // it up within ~1.5s. The id is for audit / cross-referencing the
  // control_commands row, not a status indicator.
  const includeId = opts.includeQueueId !== false;
  return {
    ok: true,
    text: includeId
      ? `${opts.successText} (tracking id=${enq.id})`
      : opts.successText,
  };
}

function ownerIdOr(store: OwnerStore | undefined, fallback: string): string {
  try {
    return store?.exists("telegram-chat-id") ? store.get("telegram-chat-id") : fallback;
  } catch {
    return fallback;
  }
}

function llmSubrouterHandler(
  args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult | Promise<ForemanCommandResult> {
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "status") return llmStatusHandler(args.slice(1), ctx);
  if (sub === "switch") {
    // Expected shape: `/foreman llm switch <provider> <model>`.
    // We forward exactly the user-supplied tokens; the start.ts drain
    // handler is the source of truth for validation (provider id,
    // model name, secret presence).
    const providerArg = args[1];
    const modelArg = args[2];
    if (!providerArg || !modelArg) {
      return {
        ok: false,
        text:
          "Usage: `/foreman llm switch <provider> <model>`. " +
          "Example: `/foreman llm switch openai gpt-6-luna`.",
        errorCode: "UNKNOWN_SUBCOMMAND",
      };
    }
    return enqueueMutating(ctx, "llm-switch", [providerArg, modelArg], {
      successText: `Will switch Foreman LLM to ${providerArg}/${modelArg}.`,
    });
  }
  if (sub === "budget") {
    const usdArg = args[1];
    const parsed = usdArg ? Number.parseFloat(usdArg) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        ok: false,
        text:
          "Usage: `/foreman llm budget <USD>`. " +
          "Example: `/foreman llm budget 25` sets the monthly cap to $25.",
        errorCode: "UNKNOWN_SUBCOMMAND",
      };
    }
    return enqueueMutating(ctx, "llm-budget", [String(parsed)], {
      successText: `Will set Foreman LLM monthly cap to $${parsed.toFixed(2)}.`,
    });
  }
  // Faz 4b / #512 — in-chat subscription login. Two-step flow because the
  // browser's loopback redirect can't reach the Foreman host across a
  // Telegram session: step 1 emits the authorize URL + persists per-user
  // PKCE state, step 2 takes the pasted redirect URL and finishes the
  // exchange. State lives in the encrypted secret store with a TTL so a
  // stale start doesn't sit around forever.
  if (sub === "login") return llmLoginChatHandler(args.slice(1), ctx);
  if (sub === "callback") return llmCallbackChatHandler(args.slice(1), ctx);
  return {
    ok: false,
    text:
      `Unknown llm subcommand "${sub}". Available: status, switch, budget, login, callback.`,
    errorCode: "UNKNOWN_SUBCOMMAND",
  };
}

// ============================================================================
// Chat-side OAuth login (#512 / Faz 4b)
// ============================================================================

/** Per-user pending OAuth login state — the PKCE bits we need to validate
 *  + finish the exchange when the user pastes the redirect URL back. */
interface PendingChatLogin {
  providerId: OAuthProviderId;
  verifier: string;
  state: string;
  createdAt: number;
}

// 10 minutes — comfortably longer than a normal browser sign-in but short
// enough that abandoned starts don't pile up in the secret store.
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

function pendingLoginSecretName(userId: string): string {
  return `oauth-pending-${userId}`;
}

function savePendingChatLogin(
  store: SecretStore,
  userId: string,
  pending: PendingChatLogin,
): void {
  const name = pendingLoginSecretName(userId);
  const json = JSON.stringify(pending);
  if (store.exists(name)) store.rotate(name, json);
  else store.add(name, json);
}

function loadPendingChatLogin(
  store: SecretStore,
  userId: string,
): PendingChatLogin | null {
  let json: string;
  try {
    json = store.get(pendingLoginSecretName(userId));
  } catch (err) {
    if (err instanceof SecretNotFoundError) return null;
    throw err;
  }
  let parsed: PendingChatLogin;
  try {
    parsed = JSON.parse(json) as PendingChatLogin;
  } catch {
    return null;
  }
  if (
    typeof parsed.providerId !== "string" ||
    typeof parsed.verifier !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.createdAt !== "number"
  ) {
    return null;
  }
  if (Date.now() - parsed.createdAt > PENDING_LOGIN_TTL_MS) {
    // Expired — drop it eagerly so the next login starts clean.
    clearPendingChatLogin(store, userId);
    return null;
  }
  return parsed;
}

function clearPendingChatLogin(store: SecretStore, userId: string): void {
  const name = pendingLoginSecretName(userId);
  if (store.exists(name)) store.remove(name);
}

function llmLoginChatHandler(
  args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const providerArg = (args[0] ?? "").toLowerCase();
  if (!providerArg) {
    return {
      ok: false,
      text:
        "Usage: `/foreman llm login <anthropic|openai>`. " +
        "Step 1 of 2 — I'll send you a URL to open in your browser.",
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  if (!isOAuthProviderId(providerArg)) {
    return {
      ok: false,
      text: `Unknown OAuth provider \`${providerArg}\`. Available: anthropic, openai.`,
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  if (!ctx.secretStore) {
    return {
      ok: false,
      text: "Server isn't wired for OAuth (no secret store).",
    };
  }
  if (!ctx.sourceUser) {
    return {
      ok: false,
      text:
        "Can't run OAuth login over this chat — no per-user identifier is " +
        "available. Use `foreman llm login` on the host instead.",
    };
  }
  const provider = getOAuthProvider(providerArg);
  const { verifier, challenge } = generatePkce();
  const state =
    provider.stateMode === "pkce-verifier" ? verifier : generateState();
  const authUrl = buildAuthorizeUrl(provider, challenge, state);
  savePendingChatLogin(ctx.secretStore, ctx.sourceUser, {
    providerId: providerArg,
    verifier,
    state,
    createdAt: Date.now(),
  });
  return {
    ok: true,
    text: [
      `Sign in to ${provider.label}:`,
      "",
      "1. Open this URL in any browser:",
      `   ${authUrl}`,
      "",
      "2. After signing in, your browser will land on a `localhost` URL that " +
        "won't load. Copy the **full URL** from the address bar.",
      "",
      "3. Send it back to me with: `/foreman llm callback <paste-url-here>`",
      "",
      `_Link expires in ${Math.round(PENDING_LOGIN_TTL_MS / 60_000)} minutes._`,
    ].join("\n"),
  };
}

async function llmCallbackChatHandler(
  args: string[],
  ctx: ForemanCommandContext,
): Promise<ForemanCommandResult> {
  // Allow the pasted URL to contain spaces by joining; the user might have
  // an OS that re-wraps long URLs across whitespace.
  const pasted = args.join(" ").trim();
  if (!pasted) {
    return {
      ok: false,
      text:
        "Usage: `/foreman llm callback <full redirect URL>`. " +
        "Run `/foreman llm login <provider>` first to get the URL.",
      errorCode: "UNKNOWN_SUBCOMMAND",
    };
  }
  if (!ctx.secretStore || !ctx.sourceUser) {
    return {
      ok: false,
      text: "No pending OAuth login (server not configured for chat login).",
    };
  }
  const pending = loadPendingChatLogin(ctx.secretStore, ctx.sourceUser);
  if (!pending) {
    return {
      ok: false,
      text:
        "No pending OAuth login (or it expired). Start with " +
        "`/foreman llm login <anthropic|openai>`.",
    };
  }
  let parsed: { code: string; state?: string };
  try {
    parsed = parseCallbackInput(pasted);
  } catch (err) {
    return {
      ok: false,
      text: `Could not parse that URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed.state !== undefined && parsed.state !== pending.state) {
    return {
      ok: false,
      text:
        "OAuth state mismatch — abort (possible CSRF). " +
        "Run `/foreman llm login` again to restart.",
    };
  }
  const provider = getOAuthProvider(pending.providerId);
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCodeForTokens(
      provider,
      { code: parsed.code, verifier: pending.verifier, state: pending.state },
      ctx.oauthFetch,
    );
  } catch (err) {
    return {
      ok: false,
      text: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  saveOAuthTokens(ctx.secretStore, pending.providerId, tokens);
  clearPendingChatLogin(ctx.secretStore, ctx.sourceUser);
  // Flip llm.yaml so the factory picks up the OAuth-aware client next call.
  try {
    const config = existsSync(ctx.llmConfigPath)
      ? loadLlmConfig(ctx.llmConfigPath)
      : defaultLlmConfig();
    saveLlmConfig(
      ctx.llmConfigPath,
      setAuthMode(config, pending.providerId, "oauth"),
    );
  } catch {
    // Tokens are persisted; the yaml flip is best-effort here. The user can
    // re-run `foreman llm status` to confirm and fix manually if needed.
  }
  const account = tokens.accountId ? ` (account ${tokens.accountId})` : "";
  return {
    ok: true,
    text:
      `✓ Signed in to ${pending.providerId}${account}. ` +
      `\`auth_mode\` set to oauth in llm.yaml — next LLM call uses your subscription.`,
  };
}

function llmStatusHandler(
  _args: string[],
  ctx: ForemanCommandContext,
): ForemanCommandResult {
  const config: LlmConfig = existsSync(ctx.llmConfigPath)
    ? loadLlmConfig(ctx.llmConfigPath)
    : defaultLlmConfig();
  if (!config.enabled) {
    return {
      ok: true,
      text:
        "Foreman LLM is **disabled** (heuristics only). Enable via `foreman llm enable` on the host.",
    };
  }
  const status = getBudgetStatus(ctx.db, config);
  const features = [
    isFeatureEnabled(config, "verification") ? "verification ✓" : null,
    isFeatureEnabled(config, "smart_report") ? "smart_report ✓" : null,
    isFeatureEnabled(config, "policy_suggestions") ? "policy_suggestions ✓" : null,
  ].filter((s): s is string => s !== null);
  const lines = [
    `Foreman LLM: ${config.provider} — ${config.model}`,
    `Budget: $${status.spentUsd.toFixed(2)} / $${status.capUsd.toFixed(2)} (${status.spentPct.toFixed(0)}%)`,
  ];
  if (features.length > 0) {
    lines.push(`Features: ${features.join(" · ")}`);
  }
  return { ok: true, text: lines.join("\n") };
}

// Compact "Xs / Xm / Xh ago" rendering — keeps Telegram replies tight.
function describeAgo(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
