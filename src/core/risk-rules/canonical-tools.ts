/**
 * Canonical tool ids for the risk-rules corpus (#552 PR 6).
 *
 * Every approval adapter in `src/core/adapters/` normalises its agent's
 * native tool names onto one of these canonical ids before handing the
 * action to the mediator. The rule corpus filters / dispatches on these
 * ids; keeping the names in one module means:
 *
 *   1. A new adapter cannot drift onto a typo that silently skips a rule.
 *   2. A rule can extend its tool-name set without spelunking every
 *      adapter file for the matching string.
 *   3. The set of tool ids the system supports is greppable in one place
 *      for docs + readiness reviews.
 *
 * The legacy non-canonical aliases (`bash`, `sh`, `execute`, …) the shell
 * patterns also recognise stay in the rule file because they are
 * historical fallbacks for partner agents that bypass the adapter layer
 * (e.g. legacy MCP `tools/call` with the raw agent-side name). New code
 * should produce the canonical ids; the aliases are a back-compat net.
 */

/**
 * Canonical id for "the agent is running a shell command". Emitted by:
 *   - codex-exec-server-v1 (item/commandExecution/requestApproval)
 *   - claude-code-pretooluse-v1 (Bash tool)
 */
export const TOOL_SHELL_EXEC = 'shell_exec'

/**
 * Canonical id for "the agent is writing to (or creating) a file".
 * Emitted by:
 *   - codex-exec-server-v1 (item/fileChange/requestApproval)
 *   - claude-code-pretooluse-v1 (Write / Edit / MultiEdit tools)
 */
export const TOOL_FILE_WRITE = 'file_write'

/**
 * Canonical id for "the agent is fetching a URL / making a network call".
 * Emitted by:
 *   - claude-code-pretooluse-v1 (WebFetch / WebSearch tools)
 *   - codex commands that resolve a host overlay are NOT remapped here
 *     today — they stay as `shell_exec` with `args.networkHost`. That's
 *     a deliberate trade-off so network-patterns still sees the curl
 *     command verbatim for regex matching.
 */
export const TOOL_NETWORK_FETCH = 'network_fetch'

/**
 * Canonical id for "the agent is calling an MCP tool on another server"
 * (i.e. a `mcp__<server>__<tool>`-shaped invocation). Emitted by
 * claude-code-pretooluse-v1.
 */
export const TOOL_MCP_CALL = 'mcp_call'

/**
 * Canonical id for "the agent wants a sandbox-overlay permission" — e.g.
 * codex asking for an extra filesystem write path before running a
 * command. Distinct from the action itself, which surfaces separately.
 */
export const TOOL_PERMISSION_OVERLAY = 'permission_overlay'

/** Set of canonical ids every adapter SHOULD emit. */
export const CANONICAL_TOOL_IDS = new Set<string>([
  TOOL_SHELL_EXEC,
  TOOL_FILE_WRITE,
  TOOL_NETWORK_FETCH,
  TOOL_MCP_CALL,
  TOOL_PERMISSION_OVERLAY,
])

/**
 * Tool names the shell-pattern rule treats as "this is a shell call".
 * Includes the canonical `shell_exec` plus legacy partner-agent aliases
 * (`bash`, `sh`, `execute_code`, …) so requests that bypass the adapter
 * layer still fire the rule.
 *
 * Adapters should produce `TOOL_SHELL_EXEC` exclusively; the aliases are
 * a safety net, not a target.
 */
export const SHELL_TOOL_NAMES = new Set<string>([
  TOOL_SHELL_EXEC,
  // Legacy / partner-agent aliases — case-insensitive at the call site.
  'execute_code',
  'run_command',
  'run_shell',
  'execute',
  'bash',
  'sh',
  'zsh',
  'exec',
])
