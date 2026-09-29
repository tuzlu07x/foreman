import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

describe('foreman inbox (#613)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-inbox-cli-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
    const db = new Database(join(home, 'foreman.db'))
    const insert = db.prepare(
      'INSERT INTO inbox_items (id, created_at, level, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run('01A', Date.now() - 60_000, 'critical', 'block', 'Blocked shell_exec from hermes', 'risk critical')
    insert.run('01B', Date.now(), 'info', 'update', 'Foreman 9.9.9 is available', '')
    db.close()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('lists items newest first with an unread count', () => {
    const out = run('inbox')
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('2 unread')
    expect(out.stdout.indexOf('Foreman 9.9.9')).toBeLessThan(out.stdout.indexOf('Blocked shell_exec'))
  })

  it('prints JSON and marks everything read', () => {
    const json = JSON.parse(run('inbox', '--json').stdout) as Array<{ title: string }>
    expect(json.map((i) => i.title)).toEqual(['Foreman 9.9.9 is available', 'Blocked shell_exec from hermes'])
    expect(run('inbox', 'read').stdout).toContain('marked 2 items read')
    expect(run('inbox', '--unread', '--json').stdout.trim()).toBe('[]')
  })
})

// QA #657 M2 — an approval that timed out with no `foreman start` running
// left no trace, and the inbox said "all caught up".
describe('foreman inbox after approvals nobody could answer', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-inbox-missed-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('reports timed-out approvals instead of "all caught up"', () => {
    const db = new Database(join(home, 'foreman.db'))
    db.prepare(
      `INSERT INTO requests (id, source_agent, target_tool, args, risk_score, decision, decided_by, created_at)
       VALUES ('req-1', 'qa-bot', 'shell_exec', '{}', 70, 'denied', 'approval-timeout', ?)`,
    ).run(Date.now() - 5_000)
    db.close()
    const out = run('inbox', '--unread')
    expect(out.status).toBe(0)
    expect(out.stdout).not.toContain('all caught up')
    expect(out.stdout).toContain("1 approval timed out while Foreman wasn't running")
    expect(out.stdout).toContain('1 unread')
    // Only reported once.
    expect(run('inbox', 'read').stdout).toContain('marked 1 item read')
    expect(run('inbox').stdout).toContain('all caught up')
  })

  it('says approvals are waiting instead of "all caught up"', () => {
    const db = new Database(join(home, 'foreman.db'))
    db.prepare(
      `INSERT INTO pending_approvals (request_id, source_agent, args, risk_score, risk_reasons, status, requested_at, deadline_ms)
       VALUES ('req-2', 'qa-bot', '{}', 70, '[]', 'pending', ?, ?)`,
    ).run(Date.now(), Date.now() + 600_000)
    db.close()
    const out = run('inbox')
    expect(out.stdout).not.toContain('all caught up')
    expect(out.stdout).toContain('1 approval waiting — run `foreman start` to answer before they time out')
  })
})
