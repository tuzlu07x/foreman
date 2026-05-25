import { describe, expect, it } from 'vitest'
import {
  claudeCodePreToolUseV1Adapter,
  AdapterDecodeError,
  type ClaudeCodePreToolUsePayload,
} from '../../../src/core/adapters/index.js'

// =============================================================================
// Decode — claude-code wire → normalised
// =============================================================================

describe('claude-code-pretooluse-v1 adapter — decodeRequest', () => {
  function payload(overrides: Partial<ClaudeCodePreToolUsePayload> = {}): ClaudeCodePreToolUsePayload {
    return {
      session_id: 'sess_1',
      cwd: '/tmp',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu_1',
      ...overrides,
    }
  }

  it('maps Bash to shell_exec with args.cmd', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({ tool_name: 'Bash', tool_input: { command: 'echo hi', cwd: '/tmp' } }),
      'claude-code',
    )
    expect(out.targetTool).toBe('shell_exec')
    expect(out.args.cmd).toBe('echo hi')
    expect(out.args.cwd).toBe('/tmp')
  })

  it('maps Write/Edit/MultiEdit to file_write with args.path', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const out = claudeCodePreToolUseV1Adapter.decodeRequest(
        payload({ tool_name: tool, tool_input: { file_path: '/x/y.ts' } }),
        'claude-code',
      )
      expect(out.targetTool).toBe('file_write')
      expect(out.args.path).toBe('/x/y.ts')
    }
  })

  it('maps WebFetch to network_fetch and extracts host', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/foo' } }),
      'claude-code',
    )
    expect(out.targetTool).toBe('network_fetch')
    expect(out.args.url).toBe('https://example.com/foo')
    expect(out.args.host).toBe('example.com')
  })

  it('maps WebSearch to network_fetch with a synthetic search: URL for rule matching', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({ tool_name: 'WebSearch', tool_input: { query: 'CVE 2026' } }),
      'claude-code',
    )
    expect(out.targetTool).toBe('network_fetch')
    expect(out.args.url).toBe('search:CVE 2026')
    expect(out.args.query).toBe('CVE 2026')
  })

  it('maps mcp__server__tool to mcp_call with parsed server + tool', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({
        tool_name: 'mcp__foreman__submit_command',
        tool_input: { target: 'codex', message: 'go' },
      }),
      'claude-code',
    )
    expect(out.targetTool).toBe('mcp_call')
    expect(out.args.server).toBe('foreman')
    expect(out.args.tool).toBe('submit_command')
    expect(out.args.args).toEqual({ target: 'codex', message: 'go' })
  })

  it('falls back to a lowercased tool_name for unknown tools', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } }),
      'claude-code',
    )
    expect(out.targetTool).toBe('glob')
    // Unknown tools pass tool_input through unchanged.
    expect(out.args.pattern).toBe('**/*.ts')
  })

  it('throws AdapterDecodeError on missing tool_name', () => {
    expect(() =>
      claudeCodePreToolUseV1Adapter.decodeRequest(
        // @ts-expect-error — exercising the runtime guard
        { tool_input: {}, session_id: 's' },
        'claude-code',
      ),
    ).toThrow(AdapterDecodeError)
  })

  it('throws AdapterDecodeError on missing tool_input object', () => {
    expect(() =>
      claudeCodePreToolUseV1Adapter.decodeRequest(
        // @ts-expect-error — exercising the runtime guard
        { tool_name: 'Bash', session_id: 's' },
        'claude-code',
      ),
    ).toThrow(AdapterDecodeError)
  })

  it('preserves session_id as the sessionId on the normalised request', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({ session_id: 'sess_xyz' }),
      'claude-code',
    )
    expect(out.sessionId).toBe('sess_xyz')
  })

  it('uses tool_use_id as the approvalId when present', () => {
    const out = claudeCodePreToolUseV1Adapter.decodeRequest(
      payload({ tool_use_id: 'tu_abc' }),
      'claude-code',
    )
    expect(out.approvalId).toBe('tu_abc')
  })
})

// =============================================================================
// Encode — normalised → claude-code wire
// =============================================================================

describe('claude-code-pretooluse-v1 adapter — encodeDecision', () => {
  it('emits hookSpecificOutput.allow on allow', () => {
    const out = claudeCodePreToolUseV1Adapter.encodeDecision({ kind: 'allow' }, 'tu_1')
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.decision).toBe('approve')
  })

  it('emits hookSpecificOutput.allow on allow_for_session (no session variant in the wire)', () => {
    const out = claudeCodePreToolUseV1Adapter.encodeDecision(
      { kind: 'allow_for_session' },
      'tu_1',
    )
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
  })

  it('emits hookSpecificOutput.deny + permissionDecisionReason on deny', () => {
    const out = claudeCodePreToolUseV1Adapter.encodeDecision(
      { kind: 'deny', reason: 'reads .env' },
      'tu_1',
    )
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('reads .env')
    // Legacy pair still emitted for older claude-code versions.
    expect(out.decision).toBe('block')
    expect(out.stopReason).toBe('reads .env')
  })

  it('collapses deny_and_interrupt onto deny (claude-code has no interrupt variant)', () => {
    const out = claudeCodePreToolUseV1Adapter.encodeDecision(
      { kind: 'deny_and_interrupt', reason: 'session loop' },
      'tu_1',
    )
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('session loop')
  })
})

// =============================================================================
// Identity
// =============================================================================

describe('claude-code-pretooluse-v1 adapter — identity', () => {
  it('exposes a stable id and label', () => {
    expect(claudeCodePreToolUseV1Adapter.id).toBe('claude-code-pretooluse-v1')
    expect(claudeCodePreToolUseV1Adapter.label).toContain('Claude Code')
  })
})
