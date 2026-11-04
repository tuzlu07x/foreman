import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Gemini CLI under Foreman
// =============================================================================
//
// Foreman runs Gemini CLI as `gemini --acp`, so its tool calls reach Foreman
// as ACP permission requests, like Hermes's: no hook, and a denial stops the
// call. Left alone, though, Gemini only asks about some tools: reads, searches
// and shell commands it calls safe (`ls`, `cat .env`) run without a word. This
// policy, loaded with `--policy`, makes it ask about every one:
//
//   - The shell needs its own rule. Gemini turns "ask" into "allow" for a
//     command it knows as safe, unless the rule has an argsPattern.
//   - Foreman's own MCP tools pass: Foreman mediates each of them itself.
//   - `--policy` takes the place of ~/.gemini/policies, so a rule of yours
//     there can't allow a tool past Foreman. An admin policy on the machine
//     still outranks it, as it would anything else.

export const GEMINI_POLICY = `# Written by Foreman: every tool call goes to Foreman, which asks you when it
# has to. Changes here are overwritten on the next task.
[[rule]]
toolName = "*"
decision = "ask_user"
priority = 800

[[rule]]
toolName = "run_shell_command"
argsPattern = ".*"
decision = "ask_user"
priority = 850

[[rule]]
mcpName = "foreman"
toolName = "*"
decision = "allow"
priority = 900
`;

/** A call no policy.yaml rule covers runs unless the risk engine objects, as
 *  for Claude Code under Foreman's hook. Otherwise a role would stop for your
 *  OK on every `ls`. Gemini has no sandbox of its own here, so the risk rules
 *  and policy.yaml are what hold it. */
export const GEMINI_POLICY_FALLBACK = { effect: "allow", source: "acp:risk-based" } as const;

/** Write the policy under Foreman's state directory and return the folder to
 *  pass to `--policy`. Refreshed on every launch, like an instance's token. */
export function writeGeminiPolicy(stateDir: string): string {
  const dir = join(stateDir, "gemini-policy");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "foreman.toml");
  writeFileSync(file, GEMINI_POLICY, { encoding: "utf-8", mode: 0o600 });
  chmodSync(file, 0o600);
  return dir;
}
