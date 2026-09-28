import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #656 (M6): remembered rules can be listed and taken back from the CLI.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

describe('foreman policy remembered', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-remembered-'))
    env = { ...process.env, FOREMAN_HOME: home, HOME: home, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
    run('init')
    writeFileSync(join(home, 'policy.yaml'), 'rules:\n  - source: "*"\n    target: tool:read_file\n    effect: ask\n')
    run('policy', 'show')
    const db = new Database(join(home, 'foreman.db'))
    db.prepare(
      "INSERT INTO policies (source_agent, target, effect, conditions, created_at, created_by, enabled) VALUES ('qa-bot', 'tool:read_file', 'deny', ?, ?, 'remember-action', 1)",
    ).run(JSON.stringify({ pathMatch: ['^/home/u/\\.ssh/id_rsa$'] }), Date.now())
    db.close()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists only remembered rules, with their scope', () => {
    const out = run('policy', 'remembered', 'list')
    expect(out.status).toBe(0)
    expect(out.stdout).toMatch(/#\d+\s+qa-bot → tool:read_file\s+DENY\s+only when path matches \^\/home\/u\/\\\.ssh\/id_rsa\$/)
    const json = JSON.parse(run('policy', 'remembered', 'list', '--json').stdout) as Array<{ sourceAgent: string }>
    expect(json.map((r) => r.sourceAgent)).toEqual(['qa-bot'])
  })

  it('removes a remembered rule, and refuses policy.yaml rules and unknown ids', () => {
    const [rule] = JSON.parse(run('policy', 'remembered', 'list', '--json').stdout) as Array<{ id: number }>
    const yamlRule = (JSON.parse(run('policy', 'show', '--json').stdout) as { rules: Array<{ id: number; createdBy: string }> })
      .rules.find((r) => r.createdBy === 'user')!
    const refused = run('policy', 'remembered', 'remove', String(yamlRule.id), '--yes')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('comes from policy.yaml')
    expect(run('policy', 'remembered', 'remove', '9999', '--yes').status).toBe(1)
    const removed = run('policy', 'remembered', 'remove', String(rule!.id), '--yes')
    expect(removed.status).toBe(0)
    expect(removed.stdout).toContain(`removed rule #${rule!.id}`)
    expect(run('policy', 'remembered', 'list').stdout).toContain('(no remembered rules)')
  })
})
