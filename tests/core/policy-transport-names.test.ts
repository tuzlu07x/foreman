import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acpStdioV1Adapter, claudeCodePreToolUseV1Adapter } from '../../src/core/adapters/index.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'
import { DEFAULT_POLICY_YAML } from '../../src/cli/policy-template.js'

// #656 (B): the default policy's secret-file guards hold whatever a
// transport calls the tool.

describe('default policy secret guards on every transport', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let engine: PolicyEngine

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    engine.loadYamlText(DEFAULT_POLICY_YAML)
  })
  afterEach(() => {
    sqlite.close()
  })

  const decide = (sourceAgent: string, targetTool: string, args: unknown) =>
    engine.evaluate({ sourceAgent, targetTool, args }).decision
  /** Asked because a guard rule matched (not merely because no rule did). */
  const guarded = (sourceAgent: string, targetTool: string, args: unknown): boolean => {
    const result = engine.evaluate({ sourceAgent, targetTool, args })
    const rule = engine.list().find((r) => r.id === result.matchedRuleId)
    return result.decision === 'ask' && rule?.effect === 'ask' && rule.conditions !== null
  }

  it('MCP (read_file / write_file) and the MCP filesystem server names', () => {
    expect(decide('claude-code', 'read_file', { path: '/app/.env' })).toBe('ask')
    expect(decide('claude-code', 'read_file', { path: 'README.md' })).toBe('allow')
    expect(guarded('claude-code', 'read_text_file', { path: '/app/.env' })).toBe(true)
    expect(guarded('claude-code', 'read_multiple_files', { paths: ['a.md', '/home/u/.ssh/id_rsa'] })).toBe(true)
    expect(guarded('claude-code', 'edit_file', { path: '/app/.env' })).toBe(true)
  })

  it('the Claude Code hook (Read / Write)', () => {
    for (const tool_name of ['Read', 'Write', 'Edit']) {
      const call = claudeCodePreToolUseV1Adapter.decodeRequest(
        { session_id: 's', tool_name, tool_input: { file_path: '/app/.env', content: 'x', old_string: 'a', new_string: 'b' } },
        'claude-code',
      )
      expect(guarded(call.sourceAgent, call.targetTool, call.args), tool_name).toBe(true)
    }
  })

  it('ACP agents (Hermes, OpenClaw, ZeroClaw): read / edit', () => {
    for (const [kind, rawInput] of [
      ['read', {}],
      ['read', { path: '/app/.env' }],
      ['edit', { file_path: '/app/.env' }],
    ] as const) {
      const call = acpStdioV1Adapter.decodeRequest(
        {
          method: 'session/request_permission',
          params: {
            sessionId: 'sess',
            toolCall: { toolCallId: 'c1', title: 'read', kind, locations: [{ path: '/app/.env' }], rawInput },
            options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
          },
        },
        'hermes',
      )
      expect(guarded(call.sourceAgent, call.targetTool, call.args), `${kind} ${JSON.stringify(rawInput)}`).toBe(true)
    }
    // Even after "always allow" on hermes' reads, a secret file still asks.
    engine.remember({ sourceAgent: 'hermes', target: 'tool:read', effect: 'allow' })
    expect(guarded('hermes', 'read', { path: '/app/.env' })).toBe(true)
    expect(decide('hermes', 'read', { path: 'README.md' })).toBe('allow')
  })

  it('an alias never widens an allow: read_file allow does not allow read_multiple_files', () => {
    expect(decide('claude-code', 'read_multiple_files', { paths: ['a.md'] })).toBe('ask')
    expect(decide('hermes', 'read', { path: 'README.md' })).toBe('ask')
  })

  it('a deny written for one name binds the others', () => {
    engine.loadYamlText(`rules:
  - source: hermes
    target: "tool:shell_exec"
    effect: deny
`)
    expect(decide('hermes', 'bash', { command: 'ls' })).toBe('deny')
    expect(decide('hermes', 'execute', { cmd: 'ls' })).toBe('deny')
  })
})
