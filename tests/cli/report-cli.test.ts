import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderDigest } from '../../src/cli/activity-cli.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

// QA #657 L30 — `foreman report`, described as a digest, printed raw JSON.
describe('foreman report', () => {
  let home: string
  const run = (...args: string[]) =>
    spawnSync('node', [FM_BIN, ...args], { env: { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }, encoding: 'utf-8' })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-report-'))
    expect(run('init').status).toBe(0)
    expect(run('agent', 'add', 'qa-bot', '--type', 'generic-mcp', '--skip-config').status).toBe(0)
    const db = new Database(join(home, 'foreman.db'))
    const ins = db.prepare(
      `INSERT INTO requests (id, source_agent, target_tool, args, risk_score, decision, decided_by, created_at)
       VALUES (?, 'qa-bot', ?, '{}', ?, ?, ?, ?)`,
    )
    ins.run('r1', 'read_file', 0, 'allowed', 'auto', Date.now() - 60_000)
    ins.run('r2', 'shell_exec', 90, 'denied', 'policy:3', Date.now() - 30_000)
    db.close()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('prints a table by default', () => {
    const out = run('report')
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('Agent activity · last 1h')
    expect(out.stdout).toMatch(/qa-bot\s+2\s+1\s+\S+ ago/)
    expect(out.stdout).toContain('Worth a look')
    expect(() => JSON.parse(out.stdout)).toThrow()
  })

  it('prints JSON with --json', () => {
    const digest = JSON.parse(run('report', '--json').stdout) as { agents: Array<{ id: string; requestCount: number }> }
    expect(digest.agents.find((a) => a.id === 'qa-bot')?.requestCount).toBe(2)
  })
})

describe('renderDigest', () => {
  it('never prints control characters from agent text: they show as stand-ins', () => {
    const now = Date.now()
    const out = renderDigest(
      {
        window: { start: now - 3_600_000, end: now },
        agents: [{ id: 'evil\u001b]0;PWNED\u0007x', displayName: 'x', runningSince: null, requestCount: 1, deniedCount: 0, lastActivityAt: null }],
        sessions: [],
        notableEvents: [
          { kind: 'denied', when: now, summary: 'denied\u001b[2J read', sourceAgent: 'x', targetTool: null, riskScore: 90 },
        ],
      },
      '1h',
      now,
    )
    expect(plain(out)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    expect(plain(out)).toContain('evil␛]0;PWNED␇x')
    expect(plain(out)).toContain('denied␛[2J read')
    expect(plain(out)).toContain('idle')
  })
})
