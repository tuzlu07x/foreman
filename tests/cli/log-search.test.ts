import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 H3 — `foreman log search claude-code` died with
// "SqliteError: no such column: code" (exit 7, raw stack).
describe('foreman log search', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-log-search-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
    const db = new Database(join(home, 'foreman.db'))
    db.prepare(
      `INSERT INTO requests (id, source_agent, target_tool, args, risk_score, decision, decided_by, created_at)
       VALUES (?, ?, ?, ?, 0, 'allowed', 'auto', ?)`,
    ).run('req-cc', 'claude-code', 'read_file', '{"path":"src/a.ts"}', Date.now())
    db.close()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it.each(['claude-code', 'foo-bar', '-x', '***', 'a AND'])('searches for %j without crashing', (query) => {
    const out = run('log', 'search', '--', query)
    expect(out.stderr).not.toMatch(/SqliteError|at .*\.js:\d+/)
    expect(out.status === 0 || out.stderr.includes('no matches')).toBe(true)
  })

  it('finds a hyphenated agent id', () => {
    const out = run('log', 'search', 'claude-code', '--json')
    expect(out.status).toBe(0)
    expect((JSON.parse(out.stdout) as Array<{ id: string }>).map((r) => r.id)).toEqual(['req-cc'])
  })
})
