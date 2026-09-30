import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasForemanHook, type ClaudeSettings } from "./agent-hook.js";
import { resolveAgentSettingsPath } from "./agent-permissions.js";
import type { RoleCapability } from "./org/org.js";

// =============================================================================
// What an agent may do on its own during a task Foreman hands it
// =============================================================================
//
// Foreman launches Claude Code (`claude --print`) and Codex (`codex exec`)
// headless, so nobody can answer the agent's own permission prompts. The
// 2.3.0 real test showed both ways this goes wrong:
//   - Claude Code refused Foreman's own tools (org_post, submit_command)
//     because nobody had allowed them, so a lead couldn't hand work on;
//   - `foreman agent trust` gave Codex `--dangerously-bypass-approvals-and-
//     sandbox`: no sandbox at all, while no Foreman hook sees Codex's shell.
//
// The rules:
//   - Claude Code may always use Foreman's own MCP tools: Foreman mediates
//     every one of them itself.
//   - Claude Code skips its own prompts only when Foreman's PreToolUse hook
//     is in its settings (every Bash, Edit, Read… then goes through
//     Foreman's policy, the role's `can` and your approval; a hook's deny
//     still wins in that mode), or when you trusted the agent.
//   - Codex always runs in its OS sandbox, never without one: read-only,
//     or, once you trusted the agent, workspace-write in the task's folder.
//     The role's `can` narrows that: no write or shell means read-only, and
//     the network is on only when the role may use it.

export interface TaskPermissionInput {
  /** The catalog agent the task runs on (an instance's type). */
  runtime: string;
  /** `foreman agent trust <id>`. */
  trusted: boolean;
  /** Claude Code only: Foreman's PreToolUse hook is in its settings
   *  (null: unknown, treated as not installed). */
  hookInstalled: boolean | null;
  /** The role's org.yaml `can`; undefined when the agent has no role or
   *  its role sets no limit. */
  can: readonly RoleCapability[] | undefined;
}

export interface TaskPermissions {
  /** Argv appended to the agent's own. */
  args: string[];
  /** One line for the audit log and `doctor`. */
  summary: string;
}

/** Codex's sandbox modes Foreman uses. `danger-full-access` never. */
export type CodexSandbox = "read-only" | "workspace-write";

export function codexSandboxFor(input: Pick<TaskPermissionInput, "trusted" | "can">): {
  sandbox: CodexSandbox;
  network: boolean;
} {
  const may = (c: RoleCapability): boolean => input.can === undefined || input.can.includes(c);
  const writes = input.trusted && (may("write") || may("shell"));
  return { sandbox: writes ? "workspace-write" : "read-only", network: writes && may("network") };
}

/** The launch flags for a task on `input.runtime`, or null for an agent
 *  these rules don't cover (its catalog `task_skip_permissions_flag`
 *  still applies). */
export function taskPermissions(input: TaskPermissionInput): TaskPermissions | null {
  if (input.runtime === "claude-code") {
    const skip = input.trusted || input.hookInstalled === true;
    return {
      args: ["--allowedTools", "mcp__foreman", ...(skip ? ["--dangerously-skip-permissions"] : [])],
      summary: skip
        ? input.hookInstalled === true
          ? "Foreman's tools allowed; every other tool call goes through Foreman's hook"
          : "Foreman's tools allowed; trusted: Claude Code's own prompts skipped (no Foreman hook installed)"
        : "Foreman's tools allowed; other tools only as Claude Code's own settings allow (no Foreman hook installed)",
    };
  }
  if (input.runtime === "codex") {
    const { sandbox, network } = codexSandboxFor(input);
    return {
      args: [
        // Foreman picks the folder (the task's project, or the role's own
        // workspace); Codex's "trusted directory" check has no one to ask.
        "--skip-git-repo-check",
        "--sandbox",
        sandbox,
        ...(sandbox === "workspace-write" ? ["-c", `sandbox_workspace_write.network_access=${network}`] : []),
      ],
      summary:
        sandbox === "read-only"
          ? `Codex sandbox: read-only${input.trusted ? " (the role may not write)" : " (trust the agent to let it write in its folder)"}`
          : `Codex sandbox: may write in its folder, network ${network ? "on" : "off"}`,
    };
  }
  return null;
}

/** Whether Claude Code's settings carry Foreman's PreToolUse hook: false
 *  when they don't, null when the file can't be read. */
export function claudeHookInstalled(configPaths: string[]): boolean | null {
  try {
    const path = resolveAgentSettingsPath(configPaths);
    if (!existsSync(path)) return false;
    return hasForemanHook(JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettings, "claude-code");
  } catch {
    return null;
  }
}

/** Where a role works when its task names no folder: its own directory
 *  under ~/foreman-work (0700), never Foreman's own config directory or
 *  the service's cwd (`/` under launchd: a sandbox rooted there could
 *  write anywhere). FOREMAN_WORK_DIR moves the parent. */
export function roleWorkspace(agentId: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const root = env.FOREMAN_WORK_DIR?.trim() || join(home, "foreman-work");
  const dir = join(root, agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
