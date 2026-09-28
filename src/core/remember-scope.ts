import { extractCommands, extractPaths, type RuleConditions } from "./policy-engine.js";

// =============================================================================
// What "always allow" / "deny always" remembers (#656)
// =============================================================================
//
// A remembered decision covers the call you answered, not every call to
// the tool: the same agent, the same tool and, when the call names a file
// or a command, that same file or command. Pressing `D` on
// `read_file("~/.ssh/id_rsa")` used to deny every read_file from the agent,
// README.md included. The approval prompt shows this scope before you
// confirm, from the same function the mediator uses to write the rule.

export interface RememberScope {
  /** Conditions for the remembered rule; undefined = every call to the tool. */
  conditions?: RuleConditions;
  /** One line for the prompt and `foreman policy remembered list`. */
  summary: string;
}

const MAX_SHOWN = 80;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clip(text: string): string {
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;
}

export function rememberScope(sourceAgent: string, targetTool: string, args: unknown): RememberScope {
  const who = `${sourceAgent} → ${targetTool}`;
  // Every spelling of the path Foreman checks (raw and `..`-collapsed), so
  // the same call matches again but no other file does.
  const paths = extractPaths(args);
  if (paths.length > 0) {
    const shown = [...new Set(paths)][0]!;
    return {
      conditions: { pathMatch: [...new Set(paths)].map((p) => `^${escapeRegExp(p)}$`) },
      summary: `${who}, only for ${JSON.stringify(clip(shown))}${paths.length > 2 ? " (and the other paths in this call)" : ""}`,
    };
  }
  const commands = extractCommands(args);
  if (commands.length > 0) {
    return {
      conditions: { commandMatch: commands },
      summary: `${who}, only for commands containing ${JSON.stringify(clip(commands[0]!))}`,
    };
  }
  return { summary: `every ${targetTool} call from ${sourceAgent}` };
}
