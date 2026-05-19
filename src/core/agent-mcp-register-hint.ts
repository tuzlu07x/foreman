import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AgentEntry } from "./registry-catalog.js";

// =============================================================================
// Post-install MCP-register CLI hint (#298 + #346)
// =============================================================================
//
// Some partner runtimes (Hermes) maintain their own MCP server registry
// CLI-side rather than reading the YAML/JSON config block we inject during
// `foreman agent add`. Round 2 QA caught this: Foreman wrote the block to
// ~/.hermes/config.yaml, but `hermes mcp list` reported "No MCP servers
// configured" because Hermes only reads its own registry.
//
// When agents.json declares `mcp_register_cli`, the install log surfaces
// the templated command after registration so the user knows the extra
// step. The template supports `{agent_id}` substitution so the command
// references the actual agent id we registered (matches `--source`).
//
// #346 — some agents (Hermes) mangle `--args "mcp-stdio --source X"` and
// never connect. When `mcp_register_cli.wrapper` is set, Foreman writes a
// tiny exec-style script to a known path and points the agent at it via
// `{wrapper_path}`. The hint builder is still pure (no disk writes); a
// separate `writeMcpWrapperScript` helper handles the side effect so tests
// stay easy.

export interface McpRegisterHint {
  command: string;
  verify: string | null;
  note: string | null;
  /** Wrapper-script payload when the agent needs one (#346). The install
   *  flow writes the file via `writeMcpWrapperScript` before logging the
   *  command. Null when the agent connects directly via `--args`. */
  wrapper: McpRegisterHintWrapper | null;
}

export interface McpRegisterHintWrapper {
  path: string;
  content: string;
}

/**
 * Build the post-install MCP register hint for an agent, or `null` if the
 * agent doesn't need one. Pure — call sites handle the wrapper-write side
 * effect separately via `writeMcpWrapperScript`.
 */
export function buildMcpRegisterHint(
  agentId: string,
  entry: AgentEntry,
  options: BuildHintOptions = {},
): McpRegisterHint | null {
  if (!entry.mcp_register_cli) return null;
  const homeDir = options.homeDir ?? homedir();
  const wrapper = entry.mcp_register_cli.wrapper
    ? {
        path: expandHome(
          substitute(entry.mcp_register_cli.wrapper.path_template, agentId),
          homeDir,
        ),
        content: substitute(
          entry.mcp_register_cli.wrapper.content_template,
          agentId,
        ),
      }
    : null;
  const command = substitute(
    entry.mcp_register_cli.command_template,
    agentId,
    wrapper?.path,
  );
  const verify = entry.mcp_register_cli.verify_template
    ? substitute(entry.mcp_register_cli.verify_template, agentId)
    : null;
  const note = entry.mcp_register_cli.note ?? null;
  return { command, verify, note, wrapper };
}

export interface BuildHintOptions {
  /** Override the home dir used to expand `~` in wrapper paths. Tests
   *  inject a tmpdir so they don't write into the real $HOME. */
  homeDir?: string;
}

/**
 * Write a wrapper script idempotently. Creates the parent dir, writes the
 * content, sets exec permissions. Returns true on a fresh write, false if
 * the file already had the expected content (so the install log can stay
 * quiet on re-runs).
 */
export function writeMcpWrapperScript(wrapper: McpRegisterHintWrapper): boolean {
  try {
    const existing = readFileSync(wrapper.path, "utf-8");
    if (existing === wrapper.content) {
      chmodSync(wrapper.path, 0o755);
      return false;
    }
  } catch {
    /* file missing — fall through to write */
  }
  mkdirSync(dirname(wrapper.path), { recursive: true });
  writeFileSync(wrapper.path, wrapper.content, "utf-8");
  chmodSync(wrapper.path, 0o755);
  return true;
}

// =============================================================================
// Auto-run MCP register command (#460)
// =============================================================================
//
// Wraps the user-facing `<agent> mcp add foreman --command ...` command
// with a `printf 'y\n' |` pipe so the interactive "Enable all N tools?
// [Y/n]" prompt the agent shows gets auto-confirmed. Best-effort: when
// the run fails (agent missing the flag, idle timeout, etc.) the caller
// surfaces the manual fallback hint that already existed pre-#460.
//
// Idempotent on re-registration: agents typically warn but don't fail
// when an MCP server name is already configured. We treat non-zero exit
// codes as "fell through; print manual fallback" rather than hard fail.

export interface AutoRegisterMcpOutcome {
  ok: boolean;
  command: string;
  /** First useful line of agent output for log surfacing. */
  firstOutputLine: string | null;
  /** Filled when `ok === false`. */
  error?: string;
}

export async function autoRegisterMcp(
  command: string,
  runShell: (
    cmd: string,
    onLine?: (line: string) => void,
  ) => Promise<{ ok: boolean; exitCode: number; manualCommand?: string }>,
  options: { onLine?: (line: string) => void } = {},
): Promise<AutoRegisterMcpOutcome> {
  // Pipe `y\n` into stdin so the agent's [Y/n] prompt auto-confirms.
  // Wrapped in `bash -c` so the pipe is honored by runShell's `|` check.
  const piped = `printf 'y\\n' | ${command}`;
  let firstOutputLine: string | null = null;
  const onLine = (line: string): void => {
    if (firstOutputLine === null && line.trim().length > 0) {
      firstOutputLine = line.trim();
    }
    options.onLine?.(line);
  };
  try {
    const result = await runShell(piped, onLine);
    if (result.ok) {
      return { ok: true, command: piped, firstOutputLine };
    }
    return {
      ok: false,
      command: piped,
      firstOutputLine,
      error: `exit ${result.exitCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      command: piped,
      firstOutputLine,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function substitute(
  template: string,
  agentId: string,
  wrapperPath?: string,
): string {
  let out = template.replace(/\{agent_id\}/g, agentId);
  if (wrapperPath !== undefined) {
    out = out.replace(/\{wrapper_path\}/g, wrapperPath);
  }
  return out;
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
  return path;
}
