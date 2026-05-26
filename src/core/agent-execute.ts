import { basename } from "node:path";
import { runAcpMediatedTask } from "./acp-mediated-task.js";
import {
  type SpawnAgentTaskOutcome,
  spawnAgentTask,
} from "./agent-spawn.js";
import type { MediatorLike } from "./codex-mediator-connector.js";
import type { FlowManager } from "./flow-manager.js";
import type { FlowRouter, RoutingDecision } from "./flow-router.js";
import type { AgentEntry } from "./registry-catalog.js";
import type { SessionManager } from "./session.js";

// =============================================================================
// Foreman → Agent task execution + output relay (PR D of orchestration epic)
// =============================================================================
//
// When `foreman write <agent> <task>` targets an agent that declares
// `task_command_template`, Foreman spawns it via the spawn engine (PR C),
// captures stdout/stderr, then posts the output back to the user's chat
// via the same Telegram bot the chat-primary agent uses. Sibling to
// `deliverWriteDirective` in agent-write.ts — that one is the queue+relay
// fallback for non-callable agents (Hermes daemon, etc.).
//
// Key UX: the user typed the directive INTO the chat-primary's chat;
// Foreman acknowledged with "Directive queued" via mcp-stdio's tool
// response; the spawn runs in the background; the captured output
// arrives as a fresh Telegram message ~seconds later. The user perceives
// it as "I asked codex to do X, codex did it, here's the result."

export interface ExecuteDirectiveInput {
  agentId: string;
  /** The user-provided task text (already stripped of `/foreman write
   *  <agent>` prefix). Substituted into the agent's
   *  task_command_template as the `{task}` placeholder. */
  message: string;
  /** Messaging-platform user id that initiated the directive. Forwarded
   *  to the output post for audit-trace alignment with the directive. */
  sourceUser?: string | undefined;
  /** Registry entry for the target agent — MUST have
   *  task_command_template; otherwise we return `unsupported` and the
   *  caller falls back to deliverWriteDirective. */
  entry: AgentEntry;
  /** Per-agent model override from `agents.model_version`. Combined
   *  with `entry.task_model_flag` by the spawn engine to inject the
   *  CLI flag (e.g. `--model claude-sonnet-4-6`). NULL/undefined =
   *  the agent's own config default. */
  modelVersion?: string | null;
  /** #517 Faz 3 — Operator has trusted this agent via
   *  `foreman agent trust <id>`. When true AND the catalog entry has
   *  `task_skip_permissions_flag`, the spawn engine appends the flag
   *  (e.g. `--full-auto` for codex, `--dangerously-skip-permissions`
   *  for claude-code) so the agent runs without its own per-call
   *  prompt. Drain handler reads `registry.get(agentId).taskSkipPermissions`
   *  + forwards it here; without this wiring the trust CLI's DB flag
   *  was a silent no-op (#544 out-of-scope finished here). */
  taskSkipPermissions?: boolean;
  /** Working directory for the spawned process. Drain handler derives
   *  this from the task text via `extractCwdFromTask(message)` so an
   *  agent task that mentions an absolute project path lands inside
   *  that project. Codex's sandbox roots include the workdir, so the
   *  cwd determines what the agent can read/write. When undefined,
   *  the spawn inherits Foreman's own cwd — works when the operator
   *  is already inside the target project but breaks when they aren't
   *  (the to-do-app QA case). */
  cwd?: string;
  /** QA-fix 2026-05-24 (Wiring 4) — SessionManager for lifecycle
   *  tracking around the spawn. When provided, the executor opens a
   *  session before spawning (`startSession` → `session:started` event
   *  → #523 lifecycle push to Telegram), then closes it on outcome
   *  (`complete` on ok, `halt` on failure/timeout/spawn-error → both
   *  emit `session:completed`). Without this, agents were silently
   *  spawned with no session row, no lifecycle pushes, no cost rollup,
   *  no `agents: last seen` heartbeat — TUI / Telegram both showed
   *  "0 active" + "never seen" while real work was happening. */
  sessionManager?: SessionManager;
  /** Responsibility-based auto-routing (docs/auto-routing-design.md).
   *  When the directive was dispatched as part of an active flow, the
   *  caller (drain handler) passes the flow + step ids + the wired
   *  router. After the spawn completes, the executor:
   *    1. marks the step completed in `flow_steps`
   *    2. asks the router what to do next (forward / finalize / halt)
   *    3. when `forward`, enqueues a new control_commands row targeting
   *       the next agent (no LLM round-trip — the router decides)
   *  Without these, executeWriteDirective stays in classic one-shot
   *  mode (output → user via Telegram). */
  flowContext?: {
    flowId: string;
    stepId: string;
    flowManager: FlowManager;
    router: FlowRouter;
    /** Called by the executor when the router returns `forward`. The
     *  drain handler implementation enqueues the new directive into
     *  `control_commands` so the next drain iteration spawns it. Kept
     *  as a callback so this module doesn't need direct DB access for
     *  control_commands. */
    enqueueFollowUp: (input: {
      targetAgent: string;
      prompt: string;
      flowId: string;
      stepId: string;
    }) => Promise<number | null>;
  };
}

export interface ExecuteDeliveryDeps {
  telegramBotToken?: string;
  telegramChatId?: string;
  fetchImpl?: typeof fetch;
  /** Spawn impl injection point for tests (forwarded into
   *  spawnAgentTask). */
  spawnImpl?: Parameters<typeof spawnAgentTask>[0]["spawnImpl"];
  /** Maximum length (chars) of agent output to include verbatim in the
   *  Telegram post. Telegram's text limit is 4096; we leave headroom for
   *  Foreman's wrapper + Markdown escaping. Default 3500. */
  maxOutputLength?: number;
  /** Mediator used by the ACP path. When the target agent declares
   *  `approval_adapter: "acp-stdio-v1"`, the executor routes through
   *  `runAcpMediatedTask` and every approval the agent emits flows
   *  through this mediator (same one the codex path uses for
   *  request_action_approval mediation). When omitted, ACP agents
   *  fall through to the legacy spawn path — which fails fast because
   *  ACP agents don't declare `task_command_template`. The drain
   *  handler in `foreman start` always wires this. */
  mediator?: MediatorLike;
  /** Spawn impl override forwarded into runAcpMediatedTask (tests). */
  acpSpawnImpl?: Parameters<typeof runAcpMediatedTask>[0]["spawnImpl"];
  /** Autonomous loop tracker. When set, the executor records the
   *  delegation lifecycle so the watchdog in `foreman start` can
   *  nudge stuck initiators. Production wires this; tests can omit
   *  it (the executor falls back to no-op tracking). */
  tracker?: DelegationTrackerLike;
  /** Identity of the agent that issued this directive (sourceAgent
   *  on the control_commands row). Used by the tracker to record
   *  "Hermes delegated to codex" so the nudge can target Hermes
   *  later. Tests can omit; production drain handler always wires
   *  it. */
  initiatorAgent?: string;
  /** Optional id of the control_commands row carrying this directive.
   *  Recorded on the delegation row for audit correlation. */
  controlCommandId?: number;
}

/** Slim interface the executor uses for the tracker — keeps the
 *  full DelegationTracker class out of agent-execute's type graph
 *  (and lets tests pass a doubles without booting an SQLite db). */
export interface DelegationTrackerLike {
  recordDelegation(input: {
    initiatorAgent: string;
    targetAgent: string;
    prompt: string;
    controlCommandId?: number | null;
  }): string;
  recordOutputReceived(input: {
    delegationId: string;
    spawnOutcome?: string;
  }): void;
}

export interface ExecuteDirectiveOutcome {
  /** Spawn result — `unsupported` when the entry has no template, all
   *  other kinds come from the spawn engine. */
  spawn: SpawnAgentTaskOutcome;
  /** Telegram relay status for the OUTPUT message (separate from the
   *  earlier directive ack). `null` when no template (no relay
   *  attempted). */
  outputRelay:
    | { status: "ok"; messageId: string }
    | { status: "skipped"; reason: string }
    | { status: "failed"; reason: string }
    | null;
  /** Routing decision the FlowRouter produced after the spawn finished.
   *  `null` when the directive wasn't part of a flow. Callers can
   *  inspect this to log/audit the chain or update the TUI. */
  routing?: RoutingDecision | null;
}

const DEFAULT_MAX_OUTPUT = 3500;
const TELEGRAM_API = "https://api.telegram.org";

/**
 * Spawn the target agent with the user's task, capture its output, and
 * post the result back to the chat-primary's Telegram. Idempotent in the
 * sense that re-calling on the same control-command row just spawns
 * again — callers (start.ts drain handler) are responsible for marking
 * the row applied/failed once.
 */
export async function executeWriteDirective(
  input: ExecuteDirectiveInput,
  deps: ExecuteDeliveryDeps = {},
): Promise<ExecuteDirectiveOutcome> {
  // Autonomous loop tracker — record the delegation BEFORE the spawn
  // so the lifecycle row exists no matter which path we take below.
  // recordOutputReceived later updates the row with the spawn outcome.
  let trackerId: string | null = null;
  if (deps.tracker && deps.initiatorAgent) {
    try {
      trackerId = deps.tracker.recordDelegation({
        initiatorAgent: deps.initiatorAgent,
        targetAgent: input.agentId,
        prompt: input.message,
        controlCommandId: deps.controlCommandId ?? null,
      });
    } catch (err) {
      // Tracking failures must not break execution. Surface to stderr
      // for visibility; the spawn continues.
      process.stderr.write(
        `foreman: delegation tracker recordDelegation failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  // #445 / #552 — ACP routing branch. When the target declares
  // `approval_adapter: "acp-stdio-v1"` + `acp_command`, the agent
  // speaks the Agent Client Protocol over stdio (Hermes, OpenClaw,
  // ZeroClaw). We spawn it via `runAcpMediatedTask` so every
  // approval the agent emits flows through Foreman's mediator. The
  // outcome is converted to SpawnAgentTaskOutcome shape so the rest
  // of this function (session lifecycle, flow routing, Telegram
  // relay) stays unchanged.
  if (
    input.entry.approval_adapter === "acp-stdio-v1" &&
    input.entry.acp_command
  ) {
    const outcome = await executeAcpDirective(input, deps);
    if (trackerId && deps.tracker) {
      try {
        deps.tracker.recordOutputReceived({
          delegationId: trackerId,
          spawnOutcome: outcome.spawn.kind,
        });
      } catch {
        /* best-effort */
      }
    }
    return outcome;
  }

  if (!input.entry.task_command_template) {
    if (trackerId && deps.tracker) {
      try {
        deps.tracker.recordOutputReceived({
          delegationId: trackerId,
          spawnOutcome: "unsupported",
        });
      } catch {
        /* best-effort */
      }
    }
    return {
      spawn: {
        kind: "unsupported",
        reason: `agent "${input.agentId}" has no task_command_template`,
      },
      outputRelay: null,
    };
  }

  // QA-fix 2026-05-24 (Wiring 4) — open a session BEFORE the spawn so
  // the lifecycle bridge can ship "▶️ codex started" to Telegram while
  // the agent is actually working. Project tag is the cwd basename
  // when we have one (#530 — surfaces as "(to-do-app)" in completion
  // pushes). All best-effort: SessionManager throw shouldn't kill the
  // spawn, so we wrap + log to stderr but proceed.
  let sessionId: string | null = null;
  if (input.sessionManager) {
    try {
      sessionId = input.sessionManager.startSession([input.agentId], {
        trigger: "user_command:write",
        ...(input.cwd
          ? { projectTag: basename(input.cwd) }
          : {}),
      });
    } catch (err) {
      process.stderr.write(
        `foreman: failed to open session for ${input.agentId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const spawn = await spawnAgentTask({
    entry: input.entry,
    task: input.message,
    modelVersion: input.modelVersion ?? null,
    // #517 Faz 3 wiring — forward the trust flag so codex / claude-code
    // get their respective `--full-auto` / `--dangerously-skip-permissions`
    // appended when the operator ran `foreman agent trust <id>`.
    taskSkipPermissions: input.taskSkipPermissions === true,
    // QA-fix 2026-05-24 — forward the derived cwd so codex's sandbox
    // workdir lands inside the project the user actually mentioned
    // (e.g. /Users/fatih/Downloads/to-do-app) instead of Foreman's
    // own checkout. Without this, codex's writable roots exclude the
    // target and the implementation never starts.
    ...(input.cwd ? { cwd: input.cwd } : {}),
    spawnImpl: deps.spawnImpl,
  });

  // QA-fix 2026-05-24 (Wiring 4) — close the session on outcome. `ok`
  // completes (success → `session:completed { outcome: 'success' }` +
  // lifecycle push). Failure modes halt the session ('manual' reason
  // since the agent didn't hit a turn/token limit — it just failed for
  // its own reasons) which fires `session:halted` + `session:completed
  // { outcome: 'halted' }`. Either way the user sees a Telegram push +
  // the TUI Sessions panel drops the row from `active`.
  if (sessionId && input.sessionManager) {
    try {
      if (spawn.kind === "ok") {
        input.sessionManager.complete(sessionId);
      } else {
        input.sessionManager.halt(sessionId, "manual");
      }
    } catch (err) {
      process.stderr.write(
        `foreman: failed to close session ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  // Responsibility-based auto-routing — let the FlowRouter classify the
  // output + decide the next step. Best-effort throughout: if any of
  // the flow plumbing throws, we still relay the output to the user
  // (current behavior) so a buggy classifier can never trap the chain.
  let routing: RoutingDecision | null = null;
  if (input.flowContext) {
    try {
      const output = renderSpawnStdout(spawn);
      const summaryForStep = output.slice(0, 600);
      if (spawn.kind === "ok") {
        input.flowContext.flowManager.completeStep(
          input.flowContext.stepId,
          null,           // classification filled below from router
          summaryForStep,
        );
      } else {
        input.flowContext.flowManager.failStep(
          input.flowContext.stepId,
          summaryForStep,
        );
      }
      routing = input.flowContext.router.routeAfterCompletion({
        flowId: input.flowContext.flowId,
        stepId: input.flowContext.stepId,
        sourceAgent: input.agentId,
        output,
        spawnOk: spawn.kind === "ok",
      });
      if (routing.kind === "forward") {
        const directiveId = await input.flowContext.enqueueFollowUp({
          targetAgent: routing.targetAgent,
          prompt: routing.prompt,
          flowId: routing.flowId,
          stepId: routing.stepId,
        });
        input.flowContext.flowManager.markStepRunning(
          routing.stepId,
          directiveId,
        );
      }
    } catch (err) {
      process.stderr.write(
        `foreman: flow routing failed for ${input.agentId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  // Telegram relay rule:
  //   - No flow → always relay (classic behavior).
  //   - Flow + routing was forward → suppress (chat would get noisy with
  //     intermediate outputs; the final summary lands when the flow
  //     finalizes).
  //   - Flow + routing finalized/halted → relay (this IS the summary).
  //   - Flow + routing noop → relay (something odd happened, default to
  //     visible).
  const suppressRelay =
    routing !== null && routing.kind === "forward";

  let outputRelay: ExecuteDirectiveOutcome["outputRelay"] = null;
  if (!suppressRelay) {
    const text = renderOutputText(input, spawn, deps.maxOutputLength);
    outputRelay = await postTelegramOutput(text, deps);
  } else {
    outputRelay = {
      status: "skipped",
      reason: `flow ${routing!.kind === "forward" ? "forward" : "noop"} — output handed to ${routing!.kind === "forward" ? routing!.targetAgent : "—"}`,
    };
  }

  // Tracker: record output_received_at + spawn outcome so the
  // watchdog can start considering this row for nudging if the
  // initiator stays idle.
  if (trackerId && deps.tracker) {
    try {
      deps.tracker.recordOutputReceived({
        delegationId: trackerId,
        spawnOutcome: spawn.kind,
      });
    } catch {
      /* best-effort */
    }
  }

  return { spawn, outputRelay, routing };
}

// =============================================================================
// ACP directive path (#445 / #552)
// =============================================================================
//
// Parallel to the spawnAgentTask branch above. The ACP-mode agent's
// JSON-RPC `session/prompt` response is structurally different from
// what spawnAgentTask captures (no stdout/stderr separation, no exit
// code), but the rest of the executor (session lifecycle, Telegram
// relay) keys off SpawnAgentTaskOutcome. Convert the ACP outcome to
// that shape via `acpOutcomeToSpawn` so the downstream code doesn't
// have to learn two transports.
//
// Flow routing is intentionally skipped for ACP today — the FlowRouter
// classifier was trained on shell + file_write outputs from codex /
// claude-code. Adapting it to ACP `session/prompt` results lands in a
// follow-up; for now ACP directives stay one-shot.

async function executeAcpDirective(
  input: ExecuteDirectiveInput,
  deps: ExecuteDeliveryDeps,
): Promise<ExecuteDirectiveOutcome> {
  if (!deps.mediator) {
    return {
      spawn: {
        kind: "spawn-error",
        error:
          `executeWriteDirective: ACP routing for "${input.agentId}" ` +
          `requires deps.mediator. The drain handler wires this; if you're ` +
          `calling executeWriteDirective directly, pass the same MediatorService ` +
          `used by mcp-stdio.`,
      },
      outputRelay: null,
    };
  }
  if (!input.entry.acp_command) {
    return {
      spawn: {
        kind: "unsupported",
        reason:
          `agent "${input.agentId}" declares approval_adapter='acp-stdio-v1' ` +
          `but no acp_command — registry validator should have caught this. ` +
          `Fix the entry or rebuild the registry.`,
      },
      outputRelay: null,
    };
  }

  // Open a session for lifecycle tracking — same pattern as the
  // spawnAgentTask path. The ACP runner's own session id (returned in
  // the outcome) is distinct from this one; the Foreman session
  // bridges the user-facing UI while the agent-side session is the
  // ACP wire detail.
  let sessionId: string | null = null;
  if (input.sessionManager) {
    try {
      sessionId = input.sessionManager.startSession([input.agentId], {
        trigger: "user_command:write",
        ...(input.cwd ? { projectTag: basename(input.cwd) } : {}),
      });
    } catch (err) {
      process.stderr.write(
        `foreman: failed to open session for ${input.agentId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const startMs = Date.now();
  const acpOutcome = await runAcpMediatedTask({
    mediator: deps.mediator,
    sourceAgent: input.agentId,
    prompt: input.message,
    cwd: input.cwd,
    spawnImpl: deps.acpSpawnImpl,
    argv: {
      command: input.entry.acp_command.command,
      args: input.entry.acp_command.args ?? [],
    },
  });
  const durationMs = Date.now() - startMs;
  const spawn = acpOutcomeToSpawn(acpOutcome, durationMs);

  // Close the session on outcome — matches the spawnAgentTask branch
  // exactly so the lifecycle bridge (#523) treats both transports
  // identically.
  if (sessionId && input.sessionManager) {
    try {
      if (spawn.kind === "ok") {
        input.sessionManager.complete(sessionId);
      } else {
        input.sessionManager.halt(sessionId, "manual");
      }
    } catch (err) {
      process.stderr.write(
        `foreman: failed to close session ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const text = renderOutputText(input, spawn, deps.maxOutputLength);
  const outputRelay = await postTelegramOutput(text, deps);

  return { spawn, outputRelay, routing: null };
}

/**
 * Convert an ACP task outcome into the SpawnAgentTaskOutcome shape so
 * downstream renderers + the session lifecycle don't have to learn
 * two transports. Pure — exported so unit tests can pin the mapping.
 */
export function acpOutcomeToSpawn(
  outcome: Awaited<ReturnType<typeof runAcpMediatedTask>>,
  durationMs: number,
): SpawnAgentTaskOutcome {
  if (outcome.ok) {
    // ACP returns the agent's reply as `result` — shape varies per
    // agent. Stringify with a 2-space indent so multi-line replies
    // render reasonably in the Telegram code block.
    const stdout =
      typeof outcome.result === "string"
        ? outcome.result
        : JSON.stringify(outcome.result, null, 2);
    return {
      kind: "ok",
      stdout,
      stderr: "",
      exitCode: 0,
      durationMs,
    };
  }
  // Failure stages map onto SpawnAgentTaskOutcome variants:
  //   timeout         → kind:'timeout' (preserves the dedicated render)
  //   everything else → kind:'failed' (exitCode=1, error on stderr)
  if (outcome.stage === "timeout") {
    return {
      kind: "timeout",
      stdout: "",
      stderr: outcome.error,
      // Match the timeout from runAcpMediatedTask's default.
      timeoutMs: 10 * 60 * 1000,
      durationMs,
    };
  }
  return {
    kind: "failed",
    exitCode: 1,
    stdout: "",
    stderr: `[ACP ${outcome.stage}] ${outcome.error}`,
    durationMs,
  };
}

function renderSpawnStdout(spawn: SpawnAgentTaskOutcome): string {
  switch (spawn.kind) {
    case "ok":
    case "failed":
    case "timeout":
      return spawn.stdout || spawn.stderr || "";
    case "spawn-error":
      return spawn.error;
    case "unsupported":
      return spawn.reason;
  }
}

/**
 * Build the Telegram message body that delivers the spawned agent's
 * output back to the user. Includes a short header showing which
 * agent ran + the spawn outcome (success/timeout/etc), then the
 * captured stdout (truncated if very long), then a stderr block when
 * present. Pure for tests.
 */
export function renderOutputText(
  input: ExecuteDirectiveInput,
  spawn: SpawnAgentTaskOutcome,
  maxLength: number = DEFAULT_MAX_OUTPUT,
): string {
  const agentName = input.entry.name || input.agentId;
  const header = `📨 *${escapeMd(agentName)}* finished your task`;
  let body: string;
  let tail = "";
  switch (spawn.kind) {
    case "ok": {
      // QA17 — Wrap stdout in a MarkdownV2 ``` code block so reserved
      // chars (`.`, `!`, `-`, `(`, `_`, …) in the agent's response
      // don't break the entire message. Inside a `pre`/`code` block
      // only `` ` `` and `\` need escaping per Telegram docs. Before
      // this fix the raw stdout caused HTTP 400 from sendMessage and
      // the user saw NOTHING — the spawn succeeded but the post was
      // dropped silently.
      body = wrapCodeBlock(spawn.stdout || "(no output)", maxLength);
      if (spawn.stderr.trim()) {
        tail = `\n\n_stderr:_\n${wrapCodeBlock(spawn.stderr, 800)}`;
      }
      break;
    }
    case "failed": {
      body =
        `⚠ Exit code: ${spawn.exitCode}\n\n` +
        (spawn.stderr.trim()
          ? `_stderr:_\n${wrapCodeBlock(spawn.stderr, 1500)}`
          : "\\(no stderr\\)");
      if (spawn.stdout.trim()) {
        tail = `\n\n_stdout:_\n${wrapCodeBlock(spawn.stdout, 1500)}`;
      }
      break;
    }
    case "timeout": {
      body =
        `⏱ Timed out after ${escapeMd((spawn.timeoutMs / 1000).toFixed(0))}s\\.\n\n` +
        (spawn.stdout.trim() || spawn.stderr.trim()
          ? `_partial output:_\n${wrapCodeBlock(
              spawn.stdout || spawn.stderr,
              1500,
            )}`
          : "\\(no output captured before timeout\\)");
      break;
    }
    case "unsupported":
      body = `⚠ Cannot spawn ${escapeMd(input.agentId)}: ${escapeMd(spawn.reason)}`;
      break;
    case "spawn-error":
      body = `✗ Spawn error: ${escapeMd(spawn.error)}`;
      break;
  }
  const taskExcerpt = truncateForTelegram(input.message, 200);
  return `${header}\n\n_Task:_ ${escapeMd(taskExcerpt)}\n\n${body}${tail}`;
}

// QA17 — Wrap arbitrary text in a MarkdownV2 code block. Inside the
// block only `\` and `` ` `` need to be backslash-escaped; everything
// else (periods, exclamations, parens, etc.) renders literally. Used
// for agent stdout/stderr where unescaped reserved chars previously
// crashed Telegram sendMessage with HTTP 400.
function wrapCodeBlock(s: string, max: number): string {
  const truncated = truncateForTelegram(s, max);
  const escaped = truncated.replace(/[\\`]/g, (m) => `\\${m}`);
  return `\`\`\`\n${escaped}\n\`\`\``;
}

function truncateForTelegram(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…(${s.length - max} more chars truncated)`;
}

async function postTelegramOutput(
  text: string,
  deps: ExecuteDeliveryDeps,
): Promise<NonNullable<ExecuteDirectiveOutcome["outputRelay"]>> {
  if (!deps.telegramBotToken) {
    return { status: "skipped", reason: "no telegram-bot-token configured" };
  }
  if (!deps.telegramChatId) {
    return { status: "skipped", reason: "no telegram-chat-id configured" };
  }
  const url = `${TELEGRAM_API}/bot${deps.telegramBotToken}/sendMessage`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: deps.telegramChatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "<no body>");
      return { status: "failed", reason: `HTTP ${res.status}: ${detail}` };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    };
    if (!body.ok || !body.result?.message_id) {
      return {
        status: "failed",
        reason: body.description ?? "Telegram sendMessage returned !ok",
      };
    }
    return { status: "ok", messageId: String(body.result.message_id) };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// MarkdownV2 reserved chars per Telegram docs.
const MD_ESCAPE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
function escapeMd(s: string): string {
  return s.replace(MD_ESCAPE, "\\$&");
}
