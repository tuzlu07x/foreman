/**
 * Registry schema tests for `input_protocol` + the mutual-exclusion
 * validator with `approval_adapter` (#445 PR 1).
 *
 * These tests don't exercise the wrap process itself (that lands in PR
 * 2); they pin the contract the wrap implementation will build on:
 *
 *   - `input_protocol` is accepted with the documented shape.
 *   - Unknown `method` or `schema` values are rejected (enum gate).
 *   - `synthetic_update_template` accepts arbitrary JSON-shaped data
 *     because template validation is the wrap's job at spawn time.
 *   - Declaring BOTH `approval_adapter` and `input_protocol` fails
 *     validation with the cross-reference to #445 in the message.
 *   - Declaring NEITHER stays valid (legacy hybrid path from #433).
 *   - Declaring just `approval_adapter` stays valid (codex case).
 *   - Declaring just `input_protocol` stays valid (Hermes/OpenClaw
 *     future case).
 */

import { describe, expect, it } from 'vitest'
import { AgentEntrySchema } from '../../src/core/registry-catalog.js'

// =============================================================================
// A minimal valid entry — required fields only — that the tests then layer
// per-case fields onto. Lets each test focus on the field it cares about.
// =============================================================================

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-agent',
    name: 'Fixture Agent',
    tagline: 'Test fixture, do not ship',
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
  }
}

const TELEGRAM_UPDATE_TEMPLATE = {
  update_id: '{auto}',
  message: {
    from: { id: '{ownerChatId}', is_bot: false },
    chat: { id: '{ownerChatId}', type: 'private' },
    text: '{directive}',
  },
}

// =============================================================================
// Acceptance — input_protocol shape
// =============================================================================

describe('registry-catalog — input_protocol field', () => {
  it('accepts a valid telegram-update input_protocol declaration', () => {
    const entry = baseEntry({
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'telegram-update',
        synthetic_update_template: TELEGRAM_UPDATE_TEMPLATE,
      },
    })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })

  it('rejects an unknown method (only stdin_jsonl supported today)', () => {
    const entry = baseEntry({
      input_protocol: {
        method: 'http_post',
        schema: 'telegram-update',
        synthetic_update_template: TELEGRAM_UPDATE_TEMPLATE,
      },
    })
    expect(() => AgentEntrySchema.parse(entry)).toThrow()
  })

  it('rejects an unknown schema (only telegram-update supported today)', () => {
    const entry = baseEntry({
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'discord-event',
        synthetic_update_template: {},
      },
    })
    expect(() => AgentEntrySchema.parse(entry)).toThrow()
  })

  it('accepts an arbitrary JSON object as synthetic_update_template (wrap validates at spawn time)', () => {
    // Template shape is intentionally loose — the registry doesn't
    // know which substitution tokens or fields the wrap needs. This
    // test pins the "loose validation" contract.
    const entry = baseEntry({
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'telegram-update',
        synthetic_update_template: {
          arbitrary: 'shape',
          nested: { value: 42 },
          tokens: ['{auto}', '{ownerChatId}', '{directive}'],
        },
      },
    })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })

  it('requires all three fields when input_protocol is present', () => {
    expect(() =>
      AgentEntrySchema.parse(
        baseEntry({
          input_protocol: { method: 'stdin_jsonl', schema: 'telegram-update' },
        }),
      ),
    ).toThrow()
    expect(() =>
      AgentEntrySchema.parse(
        baseEntry({
          input_protocol: {
            method: 'stdin_jsonl',
            synthetic_update_template: TELEGRAM_UPDATE_TEMPLATE,
          },
        }),
      ),
    ).toThrow()
    expect(() =>
      AgentEntrySchema.parse(
        baseEntry({
          input_protocol: {
            schema: 'telegram-update',
            synthetic_update_template: TELEGRAM_UPDATE_TEMPLATE,
          },
        }),
      ),
    ).toThrow()
  })

  it('input_protocol is optional — entries without it stay valid (legacy hybrid path)', () => {
    expect(() => AgentEntrySchema.parse(baseEntry())).not.toThrow()
  })
})

// =============================================================================
// Mutual exclusion — `approval_adapter` ↔ `input_protocol`
// =============================================================================

describe('registry-catalog — mutual exclusion between approval_adapter and input_protocol', () => {
  it('rejects entries that declare BOTH approval_adapter and input_protocol', () => {
    const entry = baseEntry({
      approval_adapter: 'codex-exec-server-v1',
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'telegram-update',
        synthetic_update_template: TELEGRAM_UPDATE_TEMPLATE,
      },
    })
    const result = AgentEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      // Cross-reference to #445 in the error so an operator can find
      // the decision matrix.
      expect(messages.some((m) => m.includes('#445'))).toBe(true)
      expect(messages.some((m) => m.includes('two distinct transport models'))).toBe(true)
    }
  })

  it('accepts just approval_adapter (codex transport model)', () => {
    const entry = baseEntry({ approval_adapter: 'codex-exec-server-v1' })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })

  it('accepts just input_protocol (Hermes/OpenClaw transport model)', () => {
    const entry = baseEntry({
      input_protocol: {
        method: 'stdin_jsonl',
        schema: 'telegram-update',
        synthetic_update_template: TELEGRAM_UPDATE_TEMPLATE,
      },
    })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })

  it('accepts neither (legacy hybrid path agents — pre-#552/445 setup)', () => {
    expect(() => AgentEntrySchema.parse(baseEntry())).not.toThrow()
  })
})

// =============================================================================
// Regression — the bundled registry still validates after the schema
// additions. Loads the real registry/agents.json and exercises every
// entry through the schema so a typo + the new mutual-exclusion rule
// can't sneak through unnoticed.
// =============================================================================

describe('registry-catalog — bundled registry still validates', () => {
  it('every agent in registry/agents.json passes the schema', async () => {
    const { loadBundledRegistry } = await import(
      '../../src/core/registry-catalog.js'
    )
    expect(() => loadBundledRegistry()).not.toThrow()
  })

  it('Hermes / OpenClaw / ZeroClaw declare approval_adapter=acp-stdio-v1 + acp_command', async () => {
    const { loadBundledRegistry } = await import(
      '../../src/core/registry-catalog.js'
    )
    const doc = loadBundledRegistry()
    for (const id of ['hermes', 'openclaw', 'zeroclaw']) {
      const entry = doc.agents.find((a) => a.id === id)
      expect(entry, `${id} present`).toBeDefined()
      expect(entry!.approval_adapter, `${id} declares ACP adapter`).toBe(
        'acp-stdio-v1',
      )
      expect(entry!.acp_command, `${id} declares acp_command`).toBeDefined()
      expect(entry!.acp_command!.command).toBe(id)
      expect(entry!.acp_command!.args).toEqual(['acp'])
    }
  })
})

// =============================================================================
// ACP-specific schema rules — acp_command requirement
// =============================================================================

describe('registry-catalog — acp_command field', () => {
  it('accepts an acp_command block alongside approval_adapter=acp-stdio-v1', () => {
    const entry = baseEntry({
      approval_adapter: 'acp-stdio-v1',
      acp_command: { command: 'fixture', args: ['acp'] },
    })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })

  it('REJECTS approval_adapter=acp-stdio-v1 WITHOUT an acp_command', () => {
    const entry = baseEntry({ approval_adapter: 'acp-stdio-v1' })
    const result = AgentEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(
        messages.some((m) => m.includes('acp_command')),
        'error mentions acp_command',
      ).toBe(true)
    }
  })

  it('allows approval_adapter=codex-exec-server-v1 without an acp_command (codex uses task_command_template instead)', () => {
    const entry = baseEntry({ approval_adapter: 'codex-exec-server-v1' })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })

  it('rejects acp_command without a command field', () => {
    const entry = baseEntry({
      approval_adapter: 'acp-stdio-v1',
      acp_command: { args: ['acp'] },
    })
    expect(() => AgentEntrySchema.parse(entry)).toThrow()
  })

  it('accepts acp_command with args omitted (some agents have no flags)', () => {
    const entry = baseEntry({
      approval_adapter: 'acp-stdio-v1',
      acp_command: { command: 'minimal-agent' },
    })
    expect(() => AgentEntrySchema.parse(entry)).not.toThrow()
  })
})
