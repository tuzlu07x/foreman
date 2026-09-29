import type { ForemanCommandResult } from "../core/foreman-command.js";

// =============================================================================
// TUI command bar (#612)
// =============================================================================
//
// The command bar gives the terminal the same verbs the chat channels have
// (`status`, `write <agent> …`, `assign <department> …`, `org`, `report`,
// `llm …`, …) plus a few that only make sense on screen (`open inbox`,
// `approve`, `clear`). Chat verbs run through the same ForemanCommandRouter
// as Telegram, so org rules, the control channel and the audit log apply
// identically; the TUI is the owner at the host, so the Telegram-id owner
// check does not.
//
// Only what the user types is executed. Text from agents (activity, inbox
// items, approval details) is never fed back into this parser.

export type TuiPage =
  | "dashboard"
  | "inbox"
  | "logs"
  | "policy"
  | "sessions"
  | "delegations"
  | "agents"
  | "providers"
  | "services"
  | "integrations"
  | "secrets"
  | "settings"
  | "team"
  | "chat"
  | "test";

export interface CommandEnv {
  /** Run a chat verb through the ForemanCommandRouter (audited). */
  dispatch(verb: string, args: string[]): Promise<ForemanCommandResult>;
  /** Router verbs, for help and completion. */
  verbs(): Array<{ verb: string; description: string }>;
  navigate(page: TuiPage): void;
  approvals: {
    /** requestId currently on screen, if any. */
    current(): string | null;
    /** "shell_exec for codex", for replies. */
    describe(requestId: string): string | null;
    count(): number;
    resolve(requestId: string, decision: { decision: "allowed" | "denied"; remember?: "allow" | "deny" }): void;
  };
  inbox: { markAllRead(): number };
  agentIds(): string[];
  /** Roles and departments from org.yaml (empty when there is none). */
  orgTargets(): string[];
  quit(): void;
}

export interface CommandOutput {
  ok: boolean;
  lines: string[];
  /** The UI should clear its output area (e.g. `clear`). */
  clear?: boolean;
}

/** What the screen looked like when the user started typing the line. */
export interface LineContext {
  /** The approval on screen when the first character was typed. */
  approvalAtStart?: string | null;
}

interface LocalCommand {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  run(args: string[], env: CommandEnv, line: LineContext): CommandOutput | Promise<CommandOutput>;
}

export const PAGE_ALIASES: Record<string, TuiPage> = {
  home: "dashboard",
  dashboard: "dashboard",
  inbox: "inbox",
  notifications: "inbox",
  logs: "logs",
  log: "logs",
  audit: "logs",
  policy: "policy",
  sessions: "sessions",
  delegations: "delegations",
  agents: "agents",
  providers: "providers",
  services: "services",
  integrations: "integrations",
  integration: "integrations",
  keys: "secrets",
  secrets: "secrets",
  settings: "settings",
  team: "team",
  org: "team",
  chat: "chat",
  foreman: "chat",
  test: "test",
};

function decide(
  env: CommandEnv,
  decision: "allowed" | "denied",
  args: string[],
  line: LineContext,
): CommandOutput {
  const id = env.approvals.current();
  if (!id) return { ok: false, lines: ["Nothing is waiting for approval."] };
  // The queue can change while a command is being typed (a timeout, a
  // Telegram tap). A decision only ever applies to the approval that was
  // on screen when the user started typing it.
  if (line.approvalAtStart !== undefined && line.approvalAtStart !== id) {
    return {
      ok: false,
      lines: [
        `The approval on screen changed while you were typing. It is now ${env.approvals.describe(id) ?? id}.`,
        "Check it, then run the command again.",
      ],
    };
  }
  const always = args[0] === "always" || args[0] === "--always";
  const what = env.approvals.describe(id) ?? id;
  env.approvals.resolve(id, {
    decision,
    ...(always ? { remember: decision === "allowed" ? "allow" : "deny" } : {}),
  });
  const verb = decision === "allowed" ? "Allowed" : "Denied";
  const left = env.approvals.count() - 1;
  return {
    ok: true,
    lines: [`${verb} ${what}${always ? " (always)" : ""}.${left > 0 ? ` ${left} more waiting.` : ""}`],
  };
}

const LOCAL_COMMANDS: LocalCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    usage: "help",
    description: "Show what you can type here",
    run: (_args, env) => ({ ok: true, lines: helpLines(env) }),
  },
  {
    name: "open",
    aliases: ["go"],
    usage: "open <page>",
    description: "Switch page (inbox, agents, team, sessions, logs, policy, secrets, settings, test, …)",
    run: (args, env) => {
      const page = PAGE_ALIASES[(args[0] ?? "").toLowerCase()];
      if (!page) {
        return { ok: false, lines: [`Unknown page. Try: ${Object.keys(PAGE_ALIASES).slice(0, 10).join(", ")}`] };
      }
      env.navigate(page);
      return { ok: true, lines: [] };
    },
  },
  {
    name: "inbox",
    usage: "inbox [read]",
    description: "Open the notification centre, or mark everything read",
    run: (args, env) => {
      if ((args[0] ?? "").toLowerCase() === "read") {
        const n = env.inbox.markAllRead();
        return { ok: true, lines: [n > 0 ? `Marked ${n} notification${n === 1 ? "" : "s"} read.` : "Inbox already clear."] };
      }
      env.navigate("inbox");
      return { ok: true, lines: [] };
    },
  },
  {
    name: "approve",
    aliases: ["allow"],
    usage: "approve [always]",
    description: "Allow the approval on screen",
    run: (args, env, line) => decide(env, "allowed", args, line),
  },
  {
    name: "deny",
    usage: "deny [always]",
    description: "Deny the approval on screen",
    run: (args, env, line) => decide(env, "denied", args, line),
  },
  {
    name: "clear",
    usage: "clear",
    description: "Clear this output",
    run: () => ({ ok: true, lines: [], clear: true }),
  },
  {
    name: "quit",
    aliases: ["exit"],
    usage: "quit",
    description: "Quit the TUI (Foreman stops guarding)",
    run: (_args, env) => {
      env.quit();
      return { ok: true, lines: [] };
    },
  },
];

const LOCAL_BY_NAME = new Map<string, LocalCommand>();
for (const c of LOCAL_COMMANDS) {
  LOCAL_BY_NAME.set(c.name, c);
  for (const a of c.aliases ?? []) LOCAL_BY_NAME.set(a, c);
}

export function tokenize(line: string): string[] {
  return line.trim().replace(/^[:/]/, "").trim().split(/\s+/).filter((t) => t.length > 0);
}

export async function executeCommand(
  line: string,
  env: CommandEnv,
  context: LineContext = {},
): Promise<CommandOutput> {
  const [head, ...args] = tokenize(line);
  if (!head) return { ok: true, lines: [] };
  const local = LOCAL_BY_NAME.get(head.toLowerCase());
  if (local) return await local.run(args, env, context);
  try {
    const result = await env.dispatch(head, args);
    const lines = stripMarkdown(result.text).split("\n");
    // Free text isn't a command: say who answers it (#657).
    if (result.answeredByLlm) {
      return { ok: result.ok, lines: ["Not a command, so Foreman's LLM answers (`help` lists the commands):", ...lines] };
    }
    if (result.errorCode === "UNKNOWN_COMMAND") {
      return {
        ok: false,
        lines: [
          `Unknown command "${head}". Type \`help\` for the list.`,
          "Free-form questions go to Foreman's LLM once it is on: `foreman llm enable orchestrator_chat`.",
        ],
      };
    }
    return { ok: result.ok, lines };
  } catch (err) {
    return { ok: false, lines: [`Failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

export interface Completion {
  /** Replacement for the whole line when there is a single match. */
  line: string | null;
  candidates: string[];
}

export function completeCommand(line: string, env: CommandEnv): Completion {
  const endsWithSpace = /\s$/.test(line);
  const tokens = tokenize(line);
  if (tokens.length === 0) return { line: null, candidates: firstWords(env).slice(0, 12) };
  const completingFirst = tokens.length === 1 && !endsWithSpace;
  const prefix = endsWithSpace ? "" : tokens[tokens.length - 1]!.toLowerCase();
  let pool: string[];
  if (completingFirst) {
    pool = firstWords(env);
  } else {
    const verb = tokens[0]!.toLowerCase();
    const argIndex = endsWithSpace ? tokens.length - 1 : tokens.length - 2;
    if (argIndex !== 0) return { line: null, candidates: [] };
    if (verb === "write") pool = env.agentIds();
    else if (verb === "assign") pool = [...env.orgTargets(), ...env.agentIds()];
    else if (verb === "open" || verb === "go") pool = Object.keys(PAGE_ALIASES);
    else if (verb === "approve" || verb === "allow" || verb === "deny") pool = ["always"];
    else if (verb === "inbox") pool = ["read"];
    else if (verb === "llm") pool = ["status", "switch", "budget", "login"];
    else return { line: null, candidates: [] };
  }
  const candidates = [...new Set(pool)].filter((w) => w.toLowerCase().startsWith(prefix)).sort();
  if (candidates.length !== 1) {
    const common = commonPrefix(candidates);
    if (common.length > prefix.length) {
      return { line: replaceLast(line, tokens, endsWithSpace, common, false), candidates };
    }
    return { line: null, candidates };
  }
  return { line: replaceLast(line, tokens, endsWithSpace, candidates[0]!, true), candidates };
}

function firstWords(env: CommandEnv): string[] {
  const local = LOCAL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter((n) => n !== "?");
  return [...new Set([...local, ...env.verbs().map((v) => v.verb), ...env.agentIds()])].sort();
}

function replaceLast(
  line: string,
  tokens: string[],
  endsWithSpace: boolean,
  word: string,
  final: boolean,
): string {
  const kept = endsWithSpace ? tokens : tokens.slice(0, -1);
  return `${[...kept, word].join(" ")}${final ? " " : ""}`;
}

function commonPrefix(words: string[]): string {
  if (words.length === 0) return "";
  let prefix = words[0]!;
  for (const w of words) {
    while (!w.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function helpLines(env: CommandEnv): string[] {
  const lines = ["On screen:"];
  for (const c of LOCAL_COMMANDS) lines.push(`  ${c.usage.padEnd(22)} ${c.description}`);
  lines.push("Your agents (same as /foreman in chat):");
  for (const v of env.verbs()) {
    if (v.description.startsWith("Alias") || LOCAL_BY_NAME.has(v.verb)) continue;
    lines.push(`  ${v.verb.padEnd(22)} ${stripMarkdown(v.description)}`);
  }
  lines.push(`  ${"<agent> <task>".padEnd(22)} Same as write <agent> <task>`);
  return lines;
}

/** Chat replies use Markdown; the terminal shows plain text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Chat help says "/foreman write …"; here you type "write …".
    .replace(/\/foreman /g, "");
}
