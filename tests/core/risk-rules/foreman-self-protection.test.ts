import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foremanSelfProtectionRule } from '../../../src/core/risk-rules/foreman-self-protection.js'
import { RiskScorer } from '../../../src/core/risk-scorer.js'
import { secretPatternRule } from '../../../src/core/risk-rules/secret-patterns.js'
import type { RiskRequest } from '../../../src/core/risk-rules/types.js'

const ctx = { db: undefined as never }

function rules(req: RiskRequest): string[] {
  return foremanSelfProtectionRule.evaluate(req, ctx).map((f) => f.rule)
}

describe('foreman self-protection rule', () => {
  let prevHome: string | undefined
  beforeEach(() => {
    prevHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = '/opt/fm-test-home'
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = prevHome
  })

  it('flags a raw SQL approval of a pending request (the self-approval attack)', () => {
    const req = {
      sourceAgent: 'claude-code',
      targetTool: 'shell_exec',
      args: {
        cmd: `sqlite3 ~/.local/state/foreman/foreman.db "UPDATE pending_approvals SET status='resolved', decision='allowed'"`,
      },
    }
    expect(rules(req)).toContain('foreman_self_tamper')
  })

  it('catches glob spellings of the database', () => {
    expect(rules({ sourceAgent: 'a', targetTool: 'shell_exec', args: { cmd: 'cp foreman*.db /tmp/x' } })).toContain(
      'foreman_self_tamper',
    )
  })

  it('flags reads of the secret-store key and the live FOREMAN_HOME', () => {
    expect(rules({ sourceAgent: 'a', targetTool: 'read_file', args: { path: '/x/secrets.key' } })).toContain(
      'foreman_self_tamper',
    )
    expect(
      rules({ sourceAgent: 'a', targetTool: 'read_file', args: { path: '/opt/fm-test-home/policy.yaml' } }),
    ).toContain('foreman_self_tamper')
  })

  it('flags writes to agent hook / MCP wiring but not reads', () => {
    const write = { sourceAgent: 'a', targetTool: 'file_write', args: { path: '/home/u/.claude/settings.json' } }
    const read = { sourceAgent: 'a', targetTool: 'read_file', args: { path: '/home/u/.claude/settings.json' } }
    expect(rules(write)).toContain('agent_wiring_tamper')
    expect(rules(read)).not.toContain('agent_wiring_tamper')
  })

  it('flags a project .mcp.json write and hub-namespaced write tools', () => {
    expect(
      rules({ sourceAgent: 'a', targetTool: 'file_write', args: { path: '/repo/.mcp.json' } }),
    ).toContain('agent_wiring_tamper')
    expect(
      rules({ sourceAgent: 'a', targetTool: 'fs__write_file', args: { path: '/home/u/.claude/settings.json' } }),
    ).toContain('agent_wiring_tamper')
  })

  it('flags mutating foreman CLI calls, allows delegation and log reading', () => {
    const cli = (cmd: string) => rules({ sourceAgent: 'a', targetTool: 'shell_exec', args: { cmd } })
    expect(cli('foreman policy reset')).toContain('foreman_cli_tamper')
    expect(cli('foreman agent trust codex')).toContain('foreman_cli_tamper')
    expect(cli('foreman secrets show github-pat --reveal')).toContain('foreman_cli_tamper')
    expect(cli('foreman write codex "fix the failing test"')).toEqual([])
    expect(cli('foreman log tail')).toEqual([])
  })

  it('ignores ordinary work', () => {
    expect(rules({ sourceAgent: 'a', targetTool: 'shell_exec', args: { cmd: 'npm test && git status' } })).toEqual([])
    expect(rules({ sourceAgent: 'a', targetTool: 'read_file', args: { path: 'src/foreman/index.ts' } })).toEqual([])
  })

  it('pushes a tamper attempt into the critical bucket through the default scorer', () => {
    const scorer = new RiskScorer(undefined as never, [foremanSelfProtectionRule])
    const out = scorer.assess({
      sourceAgent: 'a',
      targetTool: 'shell_exec',
      args: { cmd: 'sqlite3 foreman.db .dump' },
    })
    expect(out.bucket).toBe('critical')
    expect(out.recommendation).not.toBe('allow')
  })
})

describe('ssh key patterns (regressions from the security audit)', () => {
  const factorsFor = (cmd: string) =>
    secretPatternRule.evaluate({ sourceAgent: 'a', targetTool: 'shell_exec', args: { cmd } }, ctx)
  it.each([
    'cat ~/.ssh/id_*',
    'cat ~/.ssh/id_ed25519_work',
    'tar czf /tmp/k.tgz ~/.ssh',
    'cp -r ~/.ssh/* /tmp/',
  ])('flags %s', (cmd) => {
    expect(factorsFor(cmd).some((f) => f.rule === 'secret_path')).toBe(true)
  })
  it('does not flag public keys', () => {
    expect(factorsFor('cat ~/.ssh/id_ed25519.pub').some((f) => f.rule === 'secret_path')).toBe(false)
  })
})
