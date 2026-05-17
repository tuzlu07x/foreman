import { describe, expect, it } from 'vitest'
import type { AgentEntry } from '../../src/core/registry-catalog.js'
import { buildMcpRegisterHint } from '../../src/core/agent-mcp-register-hint.js'

// =============================================================================
// Pure-logic tests for #298 — post-install MCP register hint
// =============================================================================
//
// Some partner runtimes (Hermes) maintain their own MCP server registry
// CLI-side. The wizard's install log surfaces the templated command after
// registration so the user knows the extra step.

function agent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: 'hermes',
    name: 'Hermes',
    tagline: 'tag',
    homepage: 'https://example.com',
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    llm_compat: [],
    mcp_compatible: true,
    supported_versions: '*',
    min_foreman_version: '0.1.0',
    ...overrides,
  }
}

describe('buildMcpRegisterHint', () => {
  it('returns null when agent has no mcp_register_cli (most agents)', () => {
    const result = buildMcpRegisterHint(
      'claude-code',
      agent({ id: 'claude-code', mcp_register_cli: undefined }),
    )
    expect(result).toBeNull()
  })

  it('returns the templated command + verify + note for Hermes', () => {
    const result = buildMcpRegisterHint(
      'hermes',
      agent({
        id: 'hermes',
        mcp_register_cli: {
          command_template:
            'hermes mcp add foreman --command foreman --args "mcp-stdio --source {agent_id}"',
          verify_template: 'hermes mcp list',
          note: 'Hermes keeps its own MCP registry separately.',
        },
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.command).toBe(
      'hermes mcp add foreman --command foreman --args "mcp-stdio --source hermes"',
    )
    expect(result!.verify).toBe('hermes mcp list')
    expect(result!.note).toBe('Hermes keeps its own MCP registry separately.')
  })

  it('substitutes {agent_id} with the actual registered id (not the catalog id)', () => {
    // User registered Hermes under a custom id like "my-hermes" via
    // `foreman agent add my-hermes --type hermes`. The --source must match
    // the actual id, not the catalog id.
    const result = buildMcpRegisterHint(
      'my-hermes',
      agent({
        id: 'hermes',
        mcp_register_cli: {
          command_template:
            'hermes mcp add foreman --command foreman --args "mcp-stdio --source {agent_id}"',
        },
      }),
    )
    expect(result!.command).toBe(
      'hermes mcp add foreman --command foreman --args "mcp-stdio --source my-hermes"',
    )
  })

  it('substitutes {agent_id} in verify_template too', () => {
    const result = buildMcpRegisterHint(
      'hermes',
      agent({
        mcp_register_cli: {
          command_template: 'cmd {agent_id}',
          verify_template: 'verify {agent_id}',
        },
      }),
    )
    expect(result!.verify).toBe('verify hermes')
  })

  it('returns null verify + note when those fields are absent', () => {
    const result = buildMcpRegisterHint(
      'x',
      agent({
        mcp_register_cli: { command_template: 'cmd {agent_id}' },
      }),
    )
    expect(result!.verify).toBeNull()
    expect(result!.note).toBeNull()
  })

  it('replaces multiple {agent_id} occurrences in the template', () => {
    const result = buildMcpRegisterHint(
      'foo',
      agent({
        mcp_register_cli: {
          command_template: 'first {agent_id} second {agent_id} done',
        },
      }),
    )
    expect(result!.command).toBe('first foo second foo done')
  })
})
