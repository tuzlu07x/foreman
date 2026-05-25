/**
 * Adapter: claude-code via the `PreToolUse` hook (#552).
 *
 * Documents — in TypeScript and in test fixtures — what claude-code's hook
 * payload actually looks like, and where Foreman has historically mapped it
 * into the mediator pipeline. The adapter is NOT yet wired into the
 * existing call site (the inline mapping in the mediator dispatch path is
 * left in place for this PR to keep behavior identical); a follow-up PR
 * flips the call site to consume this adapter so claude-code and codex
 * share the same seam.
 *
 * Why ship the adapter ahead of the cutover: it (a) freezes a stable shape
 * we can test claude-code regression against and (b) makes the interface
 * non-trivial to break — two adapters using it shake out mistakes a single
 * adapter would not surface.
 *
 * Tool-name normalisation:
 *
 *   Bash         → shell_exec       (args.cmd from tool_input.command)
 *   Write        → file_write       (args.path from tool_input.file_path)
 *   Edit         → file_write       (args.path from tool_input.file_path)
 *   MultiEdit    → file_write       (args.path from tool_input.file_path)
 *   WebFetch     → network_fetch    (args.url + parsed args.host)
 *   WebSearch    → network_fetch    (args.url='search:'+query for rule match)
 *   mcp__*       → mcp_call         (args.server + args.tool from tool_name)
 *   anything else→ tool_name (lowercased) — leaves room for future
 *                  claude-code tools without an adapter update
 *
 * The decision space claude-code's hook understands (per the upstream
 * Anthropic docs and our binary-string archaeology):
 *
 *   { hookSpecificOutput: { hookEventName: "PreToolUse",
 *     permissionDecision: "allow" | "deny",
 *     permissionDecisionReason: string } }
 *
 * Plus a top-level `decision`/`stopReason` legacy pair for older versions.
 * This adapter emits the `hookSpecificOutput` form — current and forward-
 * compatible.
 */

import {
  AdapterDecodeError,
  type AgentAdapter,
  type NormalisedActionRequest,
  type NormalisedDecision,
} from './types.js'

const ADAPTER_ID = 'claude-code-pretooluse-v1'

// =============================================================================
// Wire types — model what we actually see on stdin from claude-code's hook
// =============================================================================

/** Hook payload claude-code pipes to stdin of the PreToolUse hook. Fields
 *  documented at https://docs.claude.com/en/docs/claude-code/hooks. */
export interface ClaudeCodePreToolUsePayload {
  session_id?: string
  cwd?: string
  hook_event_name?: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  /** Older payloads (v1.4-ish) used `tool_use_id`; newer ones surface
   *  `transcript_path` + `permission_mode`. Captured loosely so the adapter
   *  doesn't break across claude-code versions. */
  tool_use_id?: string
  transcript_path?: string
  permission_mode?: string
}

/** Response shape the hook script writes to stdout to allow / deny. */
export interface ClaudeCodePreToolUseResponse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow' | 'deny'
    permissionDecisionReason?: string
  }
  /** Legacy pair — emitted alongside hookSpecificOutput for back-compat
   *  with claude-code versions older than the PermissionRequest split. */
  decision?: 'approve' | 'block'
  stopReason?: string
}

// =============================================================================
// Tool-name + args normalisation
// =============================================================================

function normaliseToolName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'mcp_call'
  switch (toolName) {
    case 'Bash':
      return 'shell_exec'
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return 'file_write'
    case 'WebFetch':
    case 'WebSearch':
      return 'network_fetch'
    default:
      return toolName.toLowerCase()
  }
}

function normaliseArgs(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'Bash') {
    return {
      cmd: typeof toolInput.command === 'string' ? toolInput.command : '',
      cwd: typeof toolInput.cwd === 'string' ? toolInput.cwd : undefined,
    }
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return {
      path:
        typeof toolInput.file_path === 'string'
          ? toolInput.file_path
          : typeof toolInput.path === 'string'
            ? toolInput.path
            : '',
    }
  }
  if (toolName === 'WebFetch') {
    const url = typeof toolInput.url === 'string' ? toolInput.url : ''
    return { url, host: extractHost(url) }
  }
  if (toolName === 'WebSearch') {
    const query = typeof toolInput.query === 'string' ? toolInput.query : ''
    return { url: `search:${query}`, query }
  }
  if (toolName.startsWith('mcp__')) {
    // claude-code mangles MCP tool ids as `mcp__<server>__<tool>`.
    const rest = toolName.slice('mcp__'.length)
    const sepIdx = rest.indexOf('__')
    const server = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest
    const tool = sepIdx >= 0 ? rest.slice(sepIdx + 2) : ''
    return { server, tool, args: toolInput }
  }
  // Unknown tool — pass tool_input through unchanged so rules that opt into
  // reading the raw shape still work.
  return { ...toolInput }
}

function extractHost(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

// =============================================================================
// Adapter
// =============================================================================

class ClaudeCodePreToolUseV1Adapter
  implements AgentAdapter<ClaudeCodePreToolUsePayload, ClaudeCodePreToolUseResponse>
{
  readonly id = ADAPTER_ID
  readonly label = 'Claude Code (PreToolUse hook)'

  decodeRequest(
    wire: ClaudeCodePreToolUsePayload,
    sourceAgent: string,
  ): NormalisedActionRequest {
    if (typeof wire.tool_name !== 'string' || wire.tool_name.length === 0) {
      throw new AdapterDecodeError(
        ADAPTER_ID,
        'PreToolUse payload missing required `tool_name`',
      )
    }
    if (typeof wire.tool_input !== 'object' || wire.tool_input === null) {
      throw new AdapterDecodeError(
        ADAPTER_ID,
        'PreToolUse payload missing required `tool_input` object',
      )
    }
    return {
      sourceAgent,
      targetTool: normaliseToolName(wire.tool_name),
      args: normaliseArgs(wire.tool_name, wire.tool_input),
      // claude-code does not surface a stable per-action approval id; the
      // session id + tool name combo is the closest proxy and is what the
      // existing PreToolUse flow uses to correlate decisions.
      approvalId:
        wire.tool_use_id ??
        `${wire.session_id ?? 'unknown'}:${wire.tool_name}:${Date.now()}`,
      sessionId: wire.session_id,
    }
  }

  encodeDecision(
    decision: NormalisedDecision,
    approvalId: string,
  ): ClaudeCodePreToolUseResponse {
    void approvalId // hook reply shape doesn't carry an approval id

    if (decision.kind === 'allow' || decision.kind === 'allow_for_session') {
      // Claude-code's hook protocol has no session-cached allow; Foreman's
      // own remember-cache handles that side. On the wire we emit a single
      // allow.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
        decision: 'approve',
      }
    }
    // deny + deny_and_interrupt collapse onto the same wire form — claude-
    // code's hook can't selectively interrupt the turn, so a deny is the
    // hard stop.
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
      decision: 'block',
      stopReason: decision.reason,
    }
  }
}

export const claudeCodePreToolUseV1Adapter: AgentAdapter<
  ClaudeCodePreToolUsePayload,
  ClaudeCodePreToolUseResponse
> = new ClaudeCodePreToolUseV1Adapter()
