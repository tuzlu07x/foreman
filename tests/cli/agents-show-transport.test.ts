/**
 * Tests for the transport-line surface added to `foreman agents show`.
 *
 * Three top-level shapes:
 *   - bridge (codex / ACP / future programmable transports)
 *   - wrap (chat-only daemon — input_protocol)
 *   - legacy (neither declared)
 *
 * The helper is exported from agents-cli.ts so we can drive it
 * without spawning the full CLI for every case.
 */

import { describe, expect, it } from 'vitest'
import { formatTransportLine } from '../../src/cli/agents-cli.js'
import type { AgentEntry } from '../../src/core/registry-catalog.js'

function entry(overrides: Record<string, unknown>): AgentEntry {
  return {
    id: 'fixture',
    name: 'Fixture',
    tagline: 't',
    homepage: 'https://example.com',
    install: { npm: null, brew: null, script: null, binary: 'fixture' },
    config_paths: ['~/.fixture/config.toml'],
    config_snippet: null,
    identity_path: '~/.fixture/AGENTS.md',
    mcp_servers_key: 'mcp_servers',
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: '>=0.0.0',
    min_foreman_version: '0.1.0',
    ...overrides,
  } as unknown as AgentEntry
}

describe('formatTransportLine', () => {
  it('renders `bridge (<adapter>)` when approval_adapter is set (ACP case)', () => {
    const e = entry({
      approval_adapter: 'acp-stdio-v1',
      acp_command: { command: 'hermes', args: ['acp'] },
    })
    expect(formatTransportLine(e)).toBe('bridge (acp-stdio-v1)')
  })

  it('renders `bridge (codex-exec-server-v1)` for codex', () => {
    const e = entry({ approval_adapter: 'codex-exec-server-v1' })
    expect(formatTransportLine(e)).toBe('bridge (codex-exec-server-v1)')
  })

  it('renders `wrap (<schema> via <method>)` when input_protocol is set', () => {
    const e = entry({
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'telegram-update',
        synthetic_update_template: {},
      },
    })
    expect(formatTransportLine(e)).toBe('wrap (telegram-update via stdin_jsonl)')
  })

  it('renders the legacy hybrid line when neither is declared', () => {
    const e = entry({})
    expect(formatTransportLine(e)).toMatch(/legacy hybrid/)
    expect(formatTransportLine(e)).toMatch(/PreToolUse/)
  })

  it('prefers approval_adapter over input_protocol — but the schema validator forbids both anyway', () => {
    // This case can't reach a real run because the registry validator
    // rejects it at parse time. Pin the helper's behaviour for the
    // hypothetical mid-refactor moment.
    const e = entry({
      approval_adapter: 'acp-stdio-v1',
      acp_command: { command: 'x', args: ['acp'] },
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'telegram-update',
        synthetic_update_template: {},
      },
    })
    expect(formatTransportLine(e)).toBe('bridge (acp-stdio-v1)')
  })
})
