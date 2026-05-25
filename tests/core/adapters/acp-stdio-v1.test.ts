/**
 * ACP adapter tests — encode/decode round-trips for the
 * `session/request_permission` method across the four Foreman decision
 * kinds and the four ACP permission-option kinds, plus failure modes.
 *
 * The adapter is pure: no IO, no clock. These tests are the contract
 * the spawn helper + bridge will build on.
 */

import { describe, expect, it } from 'vitest'
import {
  acpStdioV1Adapter,
  AdapterDecodeError,
  type AcpPermissionOption,
  type AcpRequestPermissionParams,
  type AcpToolCall,
  type NormalisedDecision,
} from '../../../src/core/adapters/index.js'

// =============================================================================
// Fixtures
// =============================================================================

const STANDARD_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'opt-allow-always', name: 'Allow + remember', kind: 'allow_always' },
  { optionId: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'opt-reject-always', name: 'Reject + remember', kind: 'reject_always' },
]

function shellCall(command: string): AcpToolCall {
  return {
    toolCallId: 'call_shell_1',
    title: `run ${command}`,
    kind: 'execute',
    rawInput: { command },
  }
}

function editCall(path: string): AcpToolCall {
  return {
    toolCallId: 'call_edit_1',
    title: `edit ${path}`,
    kind: 'edit',
    locations: [{ path }],
    rawInput: { file_path: path, content: 'irrelevant' },
  }
}

function fetchCall(url: string): AcpToolCall {
  return {
    toolCallId: 'call_fetch_1',
    title: `GET ${url}`,
    kind: 'fetch',
    rawInput: { url, method: 'GET' },
  }
}

function paramsWith(
  tool: AcpToolCall,
  options: AcpPermissionOption[] = STANDARD_OPTIONS,
): AcpRequestPermissionParams {
  return { sessionId: 'sess-acp-1', toolCall: tool, options }
}

// =============================================================================
// Decode — ACP → normalised
// =============================================================================

describe('acp-stdio-v1 adapter — decodeRequest (execute / shell)', () => {
  it('normalises a shell tool call to shell_exec with args.cmd', () => {
    const out = acpStdioV1Adapter.decodeRequest(
      {
        method: 'session/request_permission',
        params: paramsWith(shellCall('rm -rf /tmp/x')),
      },
      'hermes',
    )
    expect(out.sourceAgent).toBe('hermes')
    expect(out.targetTool).toBe('shell_exec')
    expect(out.args.cmd).toBe('rm -rf /tmp/x')
    expect(out.approvalId).toBe('call_shell_1')
    expect(out.sessionId).toBe('sess-acp-1')
    expect(out.reason).toContain('run rm -rf')
  })

  it('falls back to title when rawInput.command is missing', () => {
    const tool: AcpToolCall = {
      toolCallId: 'c1',
      title: 'echo hello',
      kind: 'execute',
      rawInput: {},
    }
    const out = acpStdioV1Adapter.decodeRequest(
      { method: 'session/request_permission', params: paramsWith(tool) },
      'hermes',
    )
    expect(out.args.cmd).toBe('echo hello')
  })

  it('also accepts cmd / script as alternative keys for the command', () => {
    const tool: AcpToolCall = {
      toolCallId: 'c1',
      title: 'fallback',
      kind: 'execute',
      rawInput: { cmd: 'ls /tmp' },
    }
    expect(
      acpStdioV1Adapter.decodeRequest(
        { method: 'session/request_permission', params: paramsWith(tool) },
        'hermes',
      ).args.cmd,
    ).toBe('ls /tmp')
  })
})

describe('acp-stdio-v1 adapter — decodeRequest (edit / file_write)', () => {
  it('normalises edit to file_write with first location path', () => {
    const out = acpStdioV1Adapter.decodeRequest(
      {
        method: 'session/request_permission',
        params: paramsWith(editCall('/Users/x/.env')),
      },
      'openclaw',
    )
    expect(out.targetTool).toBe('file_write')
    expect(out.args.path).toBe('/Users/x/.env')
    expect(out.args.kind).toBe('edit')
  })

  it('also maps delete + move to file_write', () => {
    for (const kind of ['delete', 'move'] as const) {
      const tool: AcpToolCall = {
        toolCallId: 'c1',
        title: 'op',
        kind,
        locations: [{ path: '/Users/x/file.txt' }],
        rawInput: {},
      }
      const out = acpStdioV1Adapter.decodeRequest(
        { method: 'session/request_permission', params: paramsWith(tool) },
        'openclaw',
      )
      expect(out.targetTool).toBe('file_write')
      expect(out.args.kind).toBe(kind)
    }
  })

  it('surfaces multi-location paths on args.paths', () => {
    const tool: AcpToolCall = {
      toolCallId: 'c1',
      title: 'multi-edit',
      kind: 'edit',
      locations: [{ path: '/a' }, { path: '/b' }],
      rawInput: {},
    }
    const out = acpStdioV1Adapter.decodeRequest(
      { method: 'session/request_permission', params: paramsWith(tool) },
      'openclaw',
    )
    expect(out.args.path).toBe('/a')
    expect(out.args.paths).toEqual(['/a', '/b'])
  })
})

describe('acp-stdio-v1 adapter — decodeRequest (fetch / network)', () => {
  it('normalises fetch to network_fetch with args.url', () => {
    const out = acpStdioV1Adapter.decodeRequest(
      {
        method: 'session/request_permission',
        params: paramsWith(fetchCall('https://example.com/api')),
      },
      'zeroclaw',
    )
    expect(out.targetTool).toBe('network_fetch')
    expect(out.args.url).toBe('https://example.com/api')
    expect(out.args.method).toBe('GET')
  })
})

describe('acp-stdio-v1 adapter — decodeRequest (other kinds)', () => {
  it('think → think (passes rawInput through)', () => {
    const tool: AcpToolCall = {
      toolCallId: 'c1',
      title: 'planning',
      kind: 'think',
      rawInput: { reason: 'figuring it out' },
    }
    const out = acpStdioV1Adapter.decodeRequest(
      { method: 'session/request_permission', params: paramsWith(tool) },
      'hermes',
    )
    expect(out.targetTool).toBe('think')
    expect(out.args.reason).toBe('figuring it out')
  })

  it('read → read (read-only ops get a canonical id but rarely flag risk rules)', () => {
    const tool: AcpToolCall = {
      toolCallId: 'c1',
      title: 'read /etc/hosts',
      kind: 'read',
      locations: [{ path: '/etc/hosts' }],
    }
    const out = acpStdioV1Adapter.decodeRequest(
      { method: 'session/request_permission', params: paramsWith(tool) },
      'hermes',
    )
    expect(out.targetTool).toBe('read')
  })

  it('missing kind → "other" pass-through', () => {
    const tool: AcpToolCall = { toolCallId: 'c1', title: 'unknown' }
    const out = acpStdioV1Adapter.decodeRequest(
      { method: 'session/request_permission', params: paramsWith(tool) },
      'hermes',
    )
    expect(out.targetTool).toBe('other')
  })
})

// =============================================================================
// Decode — fail-closed paths
// =============================================================================

describe('acp-stdio-v1 adapter — decode fail-closed', () => {
  it('throws AdapterDecodeError on missing sessionId', () => {
    expect(() =>
      acpStdioV1Adapter.decodeRequest(
        {
          method: 'session/request_permission',
          params: {
            sessionId: '',
            toolCall: shellCall('ls'),
            options: STANDARD_OPTIONS,
          },
        },
        'hermes',
      ),
    ).toThrow(AdapterDecodeError)
  })

  it('throws AdapterDecodeError on missing toolCallId', () => {
    const tool: AcpToolCall = { toolCallId: '', title: 'broken', kind: 'execute' }
    expect(() =>
      acpStdioV1Adapter.decodeRequest(
        { method: 'session/request_permission', params: paramsWith(tool) },
        'hermes',
      ),
    ).toThrow(AdapterDecodeError)
  })

  it('throws AdapterDecodeError on empty options array', () => {
    expect(() =>
      acpStdioV1Adapter.decodeRequest(
        {
          method: 'session/request_permission',
          params: paramsWith(shellCall('ls'), []),
        },
        'hermes',
      ),
    ).toThrow(AdapterDecodeError)
  })
})

// =============================================================================
// Encode — normalised → ACP option pick
// =============================================================================

type EncodeFn = (
  d: NormalisedDecision,
  approvalId: string,
  options?: AcpPermissionOption[],
) => { method: string; result: { outcome: { outcome: string; optionId?: string } } }

const encode = acpStdioV1Adapter.encodeDecision.bind(
  acpStdioV1Adapter,
) as unknown as EncodeFn

describe('acp-stdio-v1 adapter — encodeDecision (exact kind match)', () => {
  it('maps allow → allow_once option', () => {
    const out = encode({ kind: 'allow' }, 'c1', STANDARD_OPTIONS)
    expect(out.result.outcome.outcome).toBe('selected')
    expect(out.result.outcome.optionId).toBe('opt-allow')
  })

  it('maps allow_for_session → allow_always option', () => {
    const out = encode({ kind: 'allow_for_session' }, 'c1', STANDARD_OPTIONS)
    expect(out.result.outcome.optionId).toBe('opt-allow-always')
  })

  it('maps deny → reject_once option', () => {
    const out = encode(
      { kind: 'deny', reason: 'risk:auto-deny' },
      'c1',
      STANDARD_OPTIONS,
    )
    expect(out.result.outcome.optionId).toBe('opt-reject')
  })

  it('maps deny_and_interrupt → reject_once (transport layer can emit session/cancel separately)', () => {
    const out = encode(
      { kind: 'deny_and_interrupt', reason: 'user halted' },
      'c1',
      STANDARD_OPTIONS,
    )
    expect(out.result.outcome.optionId).toBe('opt-reject')
  })
})

describe('acp-stdio-v1 adapter — encodeDecision (family fallback)', () => {
  it('allow_for_session falls back to any allow_* option when allow_always is missing', () => {
    const reduced: AcpPermissionOption[] = [
      { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
    ]
    const out = encode({ kind: 'allow_for_session' }, 'c1', reduced)
    expect(out.result.outcome.optionId).toBe('opt-allow')
  })

  it('deny falls back to any reject_* option', () => {
    const reduced: AcpPermissionOption[] = [
      { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-reject-always', name: 'Reject + remember', kind: 'reject_always' },
    ]
    const out = encode({ kind: 'deny', reason: 'r' }, 'c1', reduced)
    expect(out.result.outcome.optionId).toBe('opt-reject-always')
  })
})

describe('acp-stdio-v1 adapter — encodeDecision (cancelled fail-safe)', () => {
  it('returns cancelled when no options are passed (transport-layer guard)', () => {
    const out = encode({ kind: 'allow' }, 'c1')
    expect(out.result.outcome.outcome).toBe('cancelled')
  })

  it('returns cancelled when no family member matches (e.g. agent offered only allow_* but we deny)', () => {
    const allowOnly: AcpPermissionOption[] = [
      { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
    ]
    const out = encode(
      { kind: 'deny', reason: 'r' },
      'c1',
      allowOnly,
    )
    expect(out.result.outcome.outcome).toBe('cancelled')
  })
})

// =============================================================================
// Identity
// =============================================================================

describe('acp-stdio-v1 adapter — identity', () => {
  it('exposes the canonical id + label', () => {
    expect(acpStdioV1Adapter.id).toBe('acp-stdio-v1')
    expect(acpStdioV1Adapter.label).toContain('ACP')
  })
})
