import { chatDeciderId } from "../approval.js";
import type { ForemanEventMap } from "../event-bus.js";
import { recommendationParts } from "../org/review.js";
import { predicateHintsForFactors } from "../risk-rules/predicate-hint.js";
import { redactSecretShapes } from "../risk-rules/secret-patterns.js";
import type { RiskBucket, RiskFactor } from "../risk-rules/types.js";
import type {
  Notification,
  NotificationAction,
  NotificationLevel,
} from "./types.js";

// =============================================================================
// Approval event → Notification mapping (#235 / C11a-2)
// =============================================================================
//
// Renders the `approval:requested` event payload into a Notification with a
// short title, factor-summarised body, and bucket-appropriate action set.
// Channel-specific styling lives in each channel's `send()` implementation —
// the renderer ships only plain text.

export function levelForBucket(bucket: RiskBucket): NotificationLevel {
  if (bucket === "critical") return "critical";
  if (bucket === "high") return "critical";
  if (bucket === "medium") return "warning";
  return "info";
}

export function renderApprovalNotification(
  req: ForemanEventMap["approval:requested"],
): Omit<Notification, "id"> {
  const level = levelForBucket(req.riskBucket);
  const title = formatTitle(req);
  const body = formatBody(req);
  const standard = buildActions(req.riskBucket, req.riskFactors);
  // #526 — when the request hit a recognisable risk factor (secret path,
  // shell-destructive command, exfil host, …) offer one-tap "block this
  // pattern permanently" buttons alongside the standard Allow / Deny.
  // The button's `intent: 'custom'` + `payload.action: 'add-deny-rule'`
  // is round-tripped via the Telegram callback_query path → the agent's
  // `submit_approval` MCP tool gets called with `action_id`, and Foreman's
  // bridge wires it into `policyEngine.addPredicateRule()`.
  const custom = buildCustomPolicyActions(req);
  return {
    level,
    requestId: req.requestId,
    title,
    body,
    actions: [...standard, ...custom],
    agentBlocking: true,
  };
}

/** #526 — Derive "block this pattern" actions from the request's risk
 *  factors. Pure function so the test surface is independent of the
 *  approval bridge. */
function buildCustomPolicyActions(
  req: ForemanEventMap["approval:requested"],
): NotificationAction[] {
  // No targetTool → no place to bind a predicate rule. Cross-agent calls
  // without a tool (pure routing) don't have a request-shape factor anyway,
  // so this branch typically returns empty.
  if (!req.targetTool) return [];
  const proposals = predicateHintsForFactors(
    req.riskFactors,
    req.args,
    req.sourceAgent,
  );
  return proposals.map((p) => ({
    id: p.actionId,
    label: p.label,
    intent: "custom" as const,
    style: "danger" as const,
    payload: {
      action: "add-deny-rule",
      sourceAgent: req.sourceAgent,
      // Bind to the matched tool — a `.env` block targets the read path
      // the agent just attempted. Future broader rules (e.g. matching
      // multiple tools) need a separate predicate type.
      target: `tool:${req.targetTool}`,
      predicate: p.predicate,
      reason: p.reason,
    },
  }));
}

function formatTitle(req: ForemanEventMap["approval:requested"]): string {
  const bucketTag = req.riskBucket.toUpperCase();
  const flow = req.targetAgent
    ? `${req.sourceAgent} → ${req.targetAgent}`
    : req.sourceAgent;
  const tool = req.targetTool ?? "(no tool)";
  return `[${bucketTag}] ${flow} · ${tool}`;
}

/** Plain words for the tools agents ask about most, keyed by the lower-cased
 *  tool name: the normalised names adapters emit (`shell_exec`,
 *  `file_write`, …) and the raw ones some paths pass through (`Bash`,
 *  `Read`, …). Anything else falls back to the tool's own name. */
const PLAIN_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  shell_exec: "run a shell command",
  bash: "run a shell command",
  shell: "run a shell command",
  exec_command: "run a shell command",
  run_shell_command: "run a shell command",
  execute: "run a shell command",
  file_write: "change a file",
  write_file: "change a file",
  edit_file: "change a file",
  write: "change a file",
  edit: "change a file",
  multiedit: "change a file",
  notebookedit: "change a notebook",
  apply_patch: "change a file",
  read_file: "read a file",
  read: "read a file",
  search_files: "search files",
  grep: "search files",
  glob: "search files",
  network_fetch: "reach the internet",
  webfetch: "fetch a web page",
  websearch: "search the web",
  mcp_call: "use an MCP tool",
  permission_overlay: "change its permissions",
  secrets_get: "read a secret",
  foreman_plan: "hand out a plan to your team",
};

/** Longest tool / agent name the lead line repeats verbatim. */
const LEAD_NAME_MAX = 60;

function leadName(name: string): string {
  // One line, bounded: names come from agents and must not forge lines.
  const flat = name.replace(/\s+/g, " ").trim();
  return flat.length <= LEAD_NAME_MAX
    ? flat
    : `${flat.slice(0, LEAD_NAME_MAX - 1)}…`;
}

/** The plain-words action for a tool name ("run a shell command"), or
 *  "use <tool>" for tools without a mapping. Exported for tests. */
export function plainToolAction(tool: string): string {
  const mapped = PLAIN_TOOL_ACTIONS[tool.toLowerCase()];
  if (mapped) return mapped;
  if (tool.startsWith("mcp__")) return `use the MCP tool ${leadName(tool)}`;
  return `use ${leadName(tool)}`;
}

/** First line of an approval message: who wants to do what, in plain
 *  words ("manager wants to run a shell command"). Channels that edit the
 *  message later (the countdown, the outcome) resend only the body, so
 *  the answer to "who is this?" has to live in the body, not the title. */
export function approvalLeadLine(
  req: Pick<
    ForemanEventMap["approval:requested"],
    "sourceAgent" | "targetAgent" | "targetTool"
  >,
): string {
  const who = leadName(req.sourceAgent);
  if (!req.targetTool) {
    return req.targetAgent
      ? `${who} wants to message ${leadName(req.targetAgent)}`
      : `${who} wants to do something that needs your approval`;
  }
  const action = plainToolAction(req.targetTool);
  return req.targetAgent
    ? `${who} wants ${leadName(req.targetAgent)} to ${action}`
    : `${who} wants to ${action}`;
}

function formatBody(req: ForemanEventMap["approval:requested"]): string {
  const lines: string[] = [];
  lines.push(approvalLeadLine(req));
  lines.push(`Risk score: ${req.riskScore}/100 (${req.riskBucket})`);

  if (req.riskFactors.length === 0 && req.riskReasons.length === 0) {
    lines.push("");
    lines.push(
      "(no specific factors — Foreman is asking because policy says ask)",
    );
  } else if (req.riskFactors.length === 0) {
    lines.push("");
    lines.push("Reasons:");
    for (const r of req.riskReasons) lines.push(`  • ${r}`);
  } else {
    const grouped = groupByCategory(req.riskFactors);
    for (const [category, factors] of grouped) {
      const total = factors.reduce((s, f) => s + f.points, 0);
      const sign = total >= 0 ? "+" : "";
      lines.push("");
      lines.push(`${categoryLabel(category)} (${sign}${total} pts):`);
      for (const f of factors) {
        const fSign = f.points >= 0 ? "+" : "";
        lines.push(`  ${fSign}${f.points}  ${f.reason}`);
      }
    }
  }

  const args = renderArgs(req.args);
  if (args) {
    lines.push("");
    lines.push(`Args: ${args}`);
  }

  // #525 — Countdown line at the bottom: "⏱ Auto-deny in 4m 12s — tap
  // [Deny] to block now." Channels that re-render every minute (Telegram
  // via CountdownTicker) call `formatCountdownLine` directly to produce
  // an updated tail; the initial body bakes the first value in.
  if (req.deadlineMs != null) {
    lines.push("");
    lines.push(formatCountdownLine(req.deadlineMs, Date.now()));
  }

  return lines.join("\n");
}

/** #525 — Render the countdown tail. The "default action" is the
 *  channel's auto-resolve outcome — Foreman always falls back to
 *  `deny` when no human decides in time, so the label is fixed for
 *  v0.1.0. (A per-route override lands later if needed.) Exported
 *  so the per-minute ticker (Telegram editMessageText) can produce
 *  matching updated tails without re-rendering the whole body. */
export function formatCountdownLine(
  deadlineMs: number,
  nowMs: number = Date.now(),
  decision: "allow" | "deny" = "deny",
): string {
  const remaining = deadlineMs - nowMs;
  if (remaining <= 0) {
    return `⏱ Timed out — auto-${decision}.`;
  }
  // Under-60s mode: show seconds + a stronger nudge so the last-minute
  // tick lands while the user is looking. Above 60s: minute granularity
  // (Telegram rate-limits message edits; minute resolution is enough).
  if (remaining < 60_000) {
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    return `⏱ Auto-${decision} in ${seconds}s — tap [Deny] to block now.`;
  }
  return `⏱ Auto-${decision} in ${formatRemaining(remaining)} — tap [Deny] to block now.`;
}

/** Format a remaining-time delta as "Xm Ys" (or "Xm" when seconds=0).
 *  Exposed so tests don't reach into formatCountdownLine for the
 *  formatting check; reused if other channels add their own tail. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function buildActions(
  bucket: RiskBucket,
  factors: RiskFactor[],
): NotificationAction[] {
  // critical bucket gets the full ladder so a tap can also persist the choice
  // as a policy rule. Lower buckets get a slimmer set so the modal doesn't
  // look spammy for low-stakes asks.
  const hasInspect = bucket === "critical" || bucket === "high";
  const actions: NotificationAction[] = [
    { id: "allow", label: "Allow once", intent: "allow", style: "primary" },
    { id: "deny", label: "Deny", intent: "deny", style: "danger" },
  ];
  if (bucket === "critical") {
    actions.push({
      id: "deny_always",
      label: "Always deny",
      intent: "remember-deny",
      style: "danger",
    });
  }
  if (hasInspect) {
    // Inspect is render-only — no round-trip action. Carries `intent: 'custom'`
    // with no payload so #522 channels (Telegram inline keyboard) can drop it
    // from the button row while keeping it in text-command fallbacks if any.
    actions.push({
      id: "inspect",
      label: "Inspect",
      intent: "custom",
      style: "neutral",
    });
  }
  // A loop factor surfaced via OOB benefits from an explicit "halt session"
  // option in the modal — but Telegram has no session-halt verb yet (C11b
  // territory). Documented as a known gap; deny remains the safe fallback.
  void factors;
  return actions;
}

function groupByCategory(
  factors: readonly RiskFactor[],
): Map<RiskFactor["category"], RiskFactor[]> {
  const out = new Map<RiskFactor["category"], RiskFactor[]>();
  for (const f of factors) {
    const existing = out.get(f.category);
    if (existing) existing.push(f);
    else out.set(f.category, [f]);
  }
  return out;
}

function categoryLabel(c: RiskFactor["category"]): string {
  switch (c) {
    case "secret":
      return "Secret-related";
    case "shell":
      return "Shell command";
    case "network":
      return "Network outbound";
    case "injection":
      return "Prompt injection";
    case "loop":
      return "Loop / session anomaly";
    case "structural":
      return "Structural";
    default:
      return c;
  }
}

function renderArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  try {
    // Notification bodies leave the machine (Telegram, Slack, webhooks) —
    // mask API keys / tokens / private keys before they do.
    const text = redactSecretShapes(JSON.stringify(args)).text;
    if (text.length <= 200) return text;
    return `${text.slice(0, 197)}…`;
  } catch {
    return String(args).slice(0, 200);
  }
}

// =============================================================================
// Manager recommendation follow-up (#623)
// =============================================================================

/** A manager agent's advice on an approval that is still open. No buttons
 *  and no approval id: the decision stays on the approval message. */
export function renderRecommendation(
  e: ForemanEventMap["approval:recommended"],
): Omit<Notification, "id"> {
  // Every agent-controlled field is one capped line, so a reason can't
  // forge lines of its own in the chat.
  const p = recommendationParts(e);
  const verb = p.recommendation === "allow" ? "✓ allow" : "✗ deny";
  return {
    level: levelForBucket(e.riskBucket),
    requestId: null,
    title: `${p.who} recommends ${p.recommendation}`,
    body:
      `🧭 ${p.who} recommends ${verb} for ${JSON.stringify(p.tool)} by ${JSON.stringify(p.requester)}: ${p.reason}\n` +
      "Advice only: your decision on the approval is still needed.",
    actions: [],
    agentBlocking: false,
  };
}

// =============================================================================
// Channel updateMessage — "decision elsewhere" follow-ups
// =============================================================================

export function renderResolvedFooter(
  e: ForemanEventMap["approval:resolved"],
): string {
  const verb = e.decision === "allowed" ? "✓ Allowed" : "✗ Denied";
  const remembered = e.remember ? `, saved as always ${e.remember}` : "";
  return `${verb} (${resolvedWhere(e)}${remembered}) at ${new Date().toISOString().slice(11, 19)}`;
}

const VIA_LABEL: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
};

/** Where / how an approval was decided, for the message's outcome line:
 *  "in the TUI", "on Slack by U0BOSS", "timed out", … Falls back to
 *  "resolved elsewhere" only when the event carries no source at all. */
function resolvedWhere(e: ForemanEventMap["approval:resolved"]): string {
  if (e.resolvedBy === "timeout") return "timed out: nobody answered in time";
  if (e.resolvedBy === "cancelled")
    return "request withdrawn: the agent stopped waiting";
  if (e.resolvedBy === "agent" || e.via === "agent_mcp") {
    return e.routedBy
      ? `relayed from ${leadName(e.routedBy)}'s chat`
      : "relayed by your chat agent";
  }
  switch (e.via) {
    case "tui":
      return "in the TUI";
    case "webhook":
      return "via webhook";
    case "telegram":
    case "slack":
    case "discord": {
      const where = `on ${VIA_LABEL[e.via]}`;
      const who = chatDeciderId(e.via, e.userId);
      return who ? `${where} by ${who}` : where;
    }
    default:
      return "resolved elsewhere";
  }
}

// =============================================================================
// Session lifecycle notifications (#523)
// =============================================================================
//
// Three small renderers turn the session:* events into Notification payloads
// the bridge can dispatch. Kept in this file (alongside the approval renderer)
// so the templates evolve together — same tone, same truncation rules, same
// channel-agnostic shape.

export function renderSessionStarted(
  e: ForemanEventMap["session:started"],
): Omit<Notification, "id"> {
  const participants = e.participants.join(" + ");
  const lines = [`▶️ ${participants} started working.`];
  lines.push(`Trigger: ${e.trigger}`);
  if (typeof e.estimatedTurns === "number") {
    lines.push(`Plan: ${e.estimatedTurns} turn`);
  }
  return {
    level: "session_lifecycle",
    requestId: null,
    title: `▶️ ${participants}`,
    body: lines.join("\n"),
    actions: [],
    agentBlocking: false,
  };
}

export function renderSessionProgress(
  e: ForemanEventMap["session:progress"],
): Omit<Notification, "id"> {
  const idShort = e.sessionId.slice(0, 6);
  const lines = [`⏳ İlerleme raporu — ${idShort}`];
  lines.push(
    `${e.turnCount} turn · ${formatTokenCount(e.tokenCount)} token · ${formatElapsed(e.elapsedMs)}`,
  );
  const last = e.recentDecisions[0];
  if (last) {
    const target = last.targetTool ?? last.targetAgent ?? "(unknown target)";
    lines.push(`Son: ${last.sourceAgent} → ${target}`);
  }
  return {
    level: "session_lifecycle",
    requestId: null,
    title: `⏳ ${idShort} · ${e.turnCount} turn`,
    body: lines.join("\n"),
    actions: [],
    agentBlocking: false,
  };
}

export function renderSessionCompleted(
  e: ForemanEventMap["session:completed"],
): Omit<Notification, "id"> {
  const idShort = e.sessionId.slice(0, 6);
  const icon = e.outcome === "success" ? "✓" : "⚠";
  // #530 — When the session declared a project tag, surface it in both
  // the title + body header so the user can scan a list of completion
  // pushes and see which project each one belongs to without expanding.
  const projectSuffix = e.projectTag ? ` (${e.projectTag})` : "";
  const lines = [`${icon} ${idShort} ${e.outcome}${projectSuffix}`];
  lines.push(
    `${e.turnCount} turn · ${formatElapsed(e.durationMs)} · $${e.costUsd.toFixed(2)}`,
  );
  if (e.reason) {
    lines.push(`Sebep: ${e.reason}`);
  }
  return {
    level: "session_lifecycle",
    requestId: null,
    title: `${icon} ${idShort} ${e.outcome}${projectSuffix}`,
    body: lines.join("\n"),
    actions: [],
    agentBlocking: false,
  };
}

/** Compact elapsed-time formatter — picks the largest unit so users
 *  scanning a Telegram push at a glance see "1h 18m" not "78m" or
 *  "4680000ms". */
export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatTokenCount(n: number): string {
  // Telegram pushes look cleaner with thin-comma separators (no toLocaleString
  // locale guessing — the format must be stable across CI + the user's
  // machine to make snapshot diffs meaningful).
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// =============================================================================
// Session resolution prompt (#527)
// =============================================================================
//
// When the loop detector halts a session, the bridge ships an interactive
// prompt with option buttons: "Skip / Let PM decide / I'll decide /
// Abandon". This renderer turns the `session:resolution-needed` event
// into a Notification with `intent: 'custom'` ChannelActions whose
// payloads encode the user's pick. The agent SOUL's callback_query
// handler relays the tap through the `submit_resolution` MCP tool.

export function renderSessionResolutionPrompt(
  e: ForemanEventMap["session:resolution-needed"],
): Omit<Notification, "id"> {
  const idShort = e.sessionId.slice(0, 6);
  const lines: string[] = [];
  lines.push(`🛑 Session needs your call — ${idShort}`);
  lines.push("");
  lines.push(e.contextSummary);
  lines.push("");
  lines.push("Pick how to continue:");
  for (const opt of e.options) {
    lines.push(`  • ${opt.label}`);
  }
  if (e.deadlineMs > 0) {
    lines.push("");
    lines.push(
      `⏱ Auto-abandon at ${new Date(e.deadlineMs).toISOString().slice(11, 19)} UTC — pick now to keep the session alive.`,
    );
  }

  const actions: NotificationAction[] = e.options.map((opt) => ({
    // Stable id used in the inline-keyboard callback_data
    // (`fa:resolve_<optionId>:<sessionId>`). The session manager's
    // provideResolution() uses the same id to look up the option +
    // its payload.
    id: `resolve_${opt.id}`,
    label: opt.label,
    intent: "custom" as const,
    payload: {
      action: "resolve-session",
      sessionId: e.sessionId,
      optionId: opt.id,
    },
    // Abandon button gets the danger colour; everything else stays
    // neutral so the user reads the labels rather than the colour cue.
    style:
      opt.id === "opt-abandon" ? ("danger" as const) : ("neutral" as const),
  }));

  return {
    level: "critical",
    requestId: null,
    title: `🛑 ${idShort} needs your call`,
    body: lines.join("\n"),
    actions,
    agentBlocking: false,
  };
}

// =============================================================================
// ask_user_with_options prompt (#528)
// =============================================================================
//
// Renders the `question:asked` event into a Notification with one
// ChannelAction per option. The agent's tool call is blocking — the
// user's tap (or free-text reply, when allowed) feeds back via the
// `submit_user_answer` MCP tool which resolves the pending_questions
// row.

export function renderUserQuestion(
  e: ForemanEventMap["question:asked"],
): Omit<Notification, "id"> {
  const idShort = e.questionId.slice(0, 6);
  const lines: string[] = [];
  lines.push(`🤖 ${e.sourceAgent} asks:`);
  lines.push("");
  lines.push(e.question);
  if (e.context && e.context.trim().length > 0) {
    lines.push("");
    lines.push(e.context.trim());
  }
  lines.push("");
  if (e.allowFreeText) {
    lines.push(
      `Tap an option below — or just type your answer if none fit. ` +
        `Foreman waits up to ${formatRemaining(e.deadlineMs - e.requestedAt)}.`,
    );
  } else {
    lines.push(
      `Pick one — Foreman waits up to ${formatRemaining(
        e.deadlineMs - e.requestedAt,
      )}.`,
    );
  }

  // Each option becomes a ChannelAction. Action id encodes the question
  // id so the agent's callback_query handler routes to submit_user_answer
  // even when several questions are open in the same chat at once.
  const actions: NotificationAction[] = e.options.map((opt) => ({
    id: `ask_${e.questionId}_${opt.id}`,
    label: opt.label,
    intent: "custom" as const,
    payload: {
      action: "answer-question",
      questionId: e.questionId,
      optionId: opt.id,
    },
    style: "primary" as const,
  }));

  return {
    level: "warning",
    requestId: null,
    title: `🤖 ${e.sourceAgent} asks (${idShort})`,
    body: lines.join("\n"),
    actions,
    agentBlocking: false,
  };
}
