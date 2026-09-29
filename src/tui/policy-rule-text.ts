import type { Effect, RuleConditions } from "../core/policy-engine.js";
import { safe } from "./format.js";

// =============================================================================
// A policy rule as one plain sentence (Policy page)
// =============================================================================
//
// Rules carry no description of their own, so the page says what a rule does
// from its effect, target and conditions: "Ask before reading secret files
// (.env, *.key, SSH keys, …)" instead of `ASK if path ~ /(^|/)\.env(\..*)?$/`.
// The bundled defaults (policy-template.ts) and the patterns Foreman writes
// itself (remember-scope.ts, predicate-hint.ts) get their own names; anything
// else reads generically ("files matching a pattern"). The raw conditions stay
// in the rule's detail view. Display only: nothing here changes a decision.

/** What a path pattern Foreman knows guards, e.g. `(^|/)\.env(\..*)?$`. */
const SECRET_PATH_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["(^|/)\\.env(\\..*)?$", ".env"],
  ["\\.env(\\..*)?$", ".env"],
  ["\\.key$", "*.key"],
  ["(^|/)id_rsa(\\.pub)?$", "SSH keys"],
  ["(^|/)id_ed25519(\\.pub)?$", "SSH keys"],
  ["/id_(rsa|ed25519|ecdsa|dsa)(\\.pub)?$", "SSH keys"],
  ["(^|/)\\.npmrc$", ".npmrc"],
  ["/\\.ssh/", "~/.ssh"],
  ["/\\.aws/credentials$", "AWS credentials"],
  ["/\\.aws/", "~/.aws"],
  ["\\.(pem|key|crt|p12|pfx)$", "private keys and certificates"],
];

/** The commands the default policy asks about, by name. */
const RISKY_COMMAND_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["rm -rf", "rm -rf"],
  ["chmod 777", "chmod 777"],
  [":(){:|:&};:", "fork bomb"],
  ["| sh", "pipe to shell"],
  ["| bash", "pipe to shell"],
  ["curl", "curl"],
  ["wget", "wget"],
];

/** Tool names (every spelling, policy-engine TOOL_ALIAS_GROUPS) → what the
 *  call does, as a verb and its object. */
const TOOL_ACTIONS: ReadonlyArray<readonly [ReadonlyArray<string>, string, string]> = [
  [["read_file", "read", "read_text_file", "read_multiple_files", "read_media_file"], "reading", "files"],
  [["file_write", "write_file", "edit_file", "write", "edit", "create_file", "move_file"], "writing", "files"],
  [["shell_exec", "execute", "execute_code", "run_command", "run_shell", "bash", "sh", "zsh", "exec"], "running", "commands"],
  [["network_fetch", "fetch", "fetch_url", "web_fetch"], "fetching", "web pages"],
  [["list_files", "list_directory"], "listing", "folders"],
  [["stat", "get_file_info"], "checking", "file details"],
];

const MAX_LISTED = 3;

/** A rule's effect, target and conditions as one sentence. */
export function describeRule(rule: {
  effect: Effect;
  target: string;
  conditions: string | null;
}): string {
  const lead = effectLead(rule.effect);
  const conditions = parseConditions(rule.conditions);
  if (conditions === "unreadable") return `${lead} ${actionOf(rule.target, {}).text} (conditions unreadable)`;
  const action = actionOf(rule.target, conditions);
  const extras = extraClauses(conditions, action);
  return [`${lead} ${action.text}`, ...extras].join(" ");
}

/** "Ask before" / "Block" / "Allow": the words the sentence starts with. */
export function effectLead(effect: Effect): string {
  if (effect === "ask") return "Ask before";
  if (effect === "deny") return "Block";
  return "Allow";
}

interface Action {
  text: string;
  /** The path / command conditions already said by `text`. */
  usedPath: boolean;
  usedCommand: boolean;
  usedTool?: boolean;
}

function actionOf(target: string, c: RuleConditions): Action {
  if (target === "*") return phrase("calling", "any tool", c);
  const at = target.indexOf(":");
  if (at < 0) return phrase("calling", `"${safe(target)}"`, c);
  const prefix = target.slice(0, at);
  const name = target.slice(at + 1);
  if (prefix === "secret") {
    return { text: `using the secret "${safe(name)}"`, usedPath: false, usedCommand: false };
  }
  if (prefix === "tool") {
    if (name === "*") return phrase("calling", "any tool", c);
    const known = TOOL_ACTIONS.find(([names]) => names.includes(name));
    if (known) return phrase(known[1], known[2], c);
    return phrase("calling", `"${safe(name)}"`, c);
  }
  // `<agent>:<tool>`: one agent calling another. Handing it work is "write".
  const agent = safe(prefix);
  if (name === "write") return { text: `handing work to ${agent}`, usedPath: false, usedCommand: false };
  if (name === "*") return { text: `calling ${agent}`, usedPath: false, usedCommand: false };
  return { text: `calling ${agent}'s "${safe(name)}"`, usedPath: false, usedCommand: false };
}

/** Verb + object, with the object narrowed by the rule's path or command
 *  condition when it is about files or commands. */
function phrase(verb: string, object: string, c: RuleConditions): Action {
  if (object === "files" && c.pathMatch?.length) {
    return { text: `${verb} ${describePaths(c.pathMatch)}`, usedPath: true, usedCommand: false };
  }
  if (object === "commands" && c.commandMatch?.length) {
    return { text: `${verb} ${describeCommands(c.commandMatch)}`, usedPath: false, usedCommand: true };
  }
  if (object === "any tool" && c.toolPattern) {
    return { text: `${verb} ${describeToolPattern(c.toolPattern)}`, usedPath: false, usedCommand: false, usedTool: true };
  }
  return { text: `${verb} ${object}`, usedPath: false, usedCommand: false };
}

function extraClauses(c: RuleConditions, action: Action): string[] {
  const out: string[] = [];
  if (c.pathMatch?.length && !action.usedPath) out.push(`on ${describePaths(c.pathMatch)}`);
  if (c.commandMatch?.length && !action.usedCommand) out.push(`for ${describeCommands(c.commandMatch)}`);
  if (c.pathNotMatch) out.push(`except ${describePaths([c.pathNotMatch])}`);
  if (c.toolPattern && !action.usedTool) out.push(`for ${describeToolPattern(c.toolPattern)}`);
  if (c.argContains) out.push(`when the call mentions "${safe(c.argContains)}"`);
  if (c.rateLimits?.messagesPerMinute) out.push(`over ${c.rateLimits.messagesPerMinute} calls a minute`);
  if (c.rateLimits?.tokensPerHour) out.push(`over ${c.rateLimits.tokensPerHour} tokens an hour`);
  return out;
}

/** Path patterns in words: "secret files (.env, SSH keys)", "the file
 *  "/p/.env"", "files named "notes.txt"" or "files matching a pattern". */
export function describePaths(patterns: string[]): string {
  const secret: string[] = [];
  const exact: string[] = [];
  const named: string[] = [];
  let other = 0;
  for (const p of patterns) {
    const name = SECRET_PATH_NAMES.find(([pattern]) => pattern === p)?.[1];
    if (name) {
      if (!secret.includes(name)) secret.push(name);
      continue;
    }
    const literal = literalPath(p);
    if (literal?.kind === "exact") exact.push(literal.text);
    else if (literal?.kind === "name") named.push(literal.text);
    else other += 1;
  }
  const parts: string[] = [];
  if (secret.length > 0) parts.push(`secret files (${secret.join(", ")})`);
  if (exact.length > 0) parts.push(`${exact.length === 1 ? "the file" : "the files"} ${listed(exact)}`);
  if (named.length > 0) parts.push(`files named ${listed(named)}`);
  if (other > 0) parts.push(`files matching ${other === 1 ? "a pattern" : `one of ${other} patterns`}`);
  return parts.join(" or ");
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).map((item) => `"${safe(item)}"`);
  const more = items.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** An exact path (`^/p/\.env$`, from "always allow / deny") or a file name
 *  (`/notes\.txt$`) written as an escaped literal; null for a real regex. */
function literalPath(pattern: string): { kind: "exact" | "name"; text: string } | null {
  const exact = /^\^(.*)\$$/.exec(pattern);
  const name = exact ? null : /^\/(.*)\$$/.exec(pattern);
  const body = exact?.[1] ?? name?.[1];
  if (body === undefined || body.length === 0) return null;
  // Every metacharacter must be escaped; then it names one path.
  if (/(^|[^\\])[.*+?^${}()|[\]]/.test(body.replace(/\\\\/g, ""))) return null;
  const text = body.replace(/\\(.)/g, "$1");
  if (name && text.includes("/")) return null;
  return { kind: exact ? "exact" : "name", text };
}

function describeCommands(commands: string[]): string {
  const names = commands.map((cmd) => RISKY_COMMAND_NAMES.find(([c]) => c === cmd)?.[1]);
  if (names.every((n): n is string => n !== undefined)) {
    return `risky commands (${[...new Set(names)].join(", ")})`;
  }
  const shown = commands.slice(0, MAX_LISTED).map((cmd) => `"${safe(cmd)}"`);
  const more = commands.length - shown.length;
  return `commands containing ${shown.join(", ")}${more > 0 ? ` or ${more} more` : ""}`;
}

function describeToolPattern(pattern: string): string {
  const prefix = /^\^([A-Za-z0-9_-]+)$/.exec(pattern);
  if (prefix) return `tools starting with "${prefix[1]}"`;
  return "tools whose name matches a pattern";
}

function parseConditions(raw: string | null): RuleConditions | "unreadable" {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RuleConditions) : "unreadable";
  } catch {
    return "unreadable";
  }
}
