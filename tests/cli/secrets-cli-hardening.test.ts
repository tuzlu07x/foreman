import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// #656: `secrets add` validates names like `${secret:<name>}` refs do,
// `--value` warns about shell history, and `show --reveal` is audited.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

describe('foreman secrets — names, --value and reveal audit (#656)', () => {
  let home: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv
  const run = (args: string[], input?: string) =>
    spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8', ...(input !== undefined ? { input } : {}) })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-secrets-h-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-secrets-hh-'))
    env = { ...process.env, FOREMAN_HOME: home, HOME: fakeHome, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
    run(['init'])
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it.each([['has space'], ['../escape'], ['evil\u001b[2Jname'], ['.hidden'], ['x'.repeat(129)]])(
    'refuses the secret name %j without echoing it',
    (name) => {
      const r = run(['secrets', 'add', name], 'value\n')
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/invalid secret name/)
      expect(r.stderr).not.toContain('\u001b[2J')
      expect(run(['secrets', 'list', '--json']).stdout).not.toContain('escape')
    },
  )

  it('accepts the documented charset, from stdin, without a history warning', () => {
    const r = run(['secrets', 'add', 'my.api_key-2'], 'v1\n')
    expect(r.status).toBe(0)
    expect(r.stderr).not.toMatch(/shell history/)
  })

  it('warns about shell history when the value comes from --value (add and rotate)', () => {
    const added = run(['secrets', 'add', 'hist-test', '--value', 'v1'])
    expect(added.status).toBe(0)
    expect(added.stderr).toMatch(/--value leaves the secret in your shell history/)
    const rotated = run(['secrets', 'rotate', 'hist-test', '--value', 'v2'])
    expect(rotated.status).toBe(0)
    expect(rotated.stderr).toMatch(/shell history/)
    expect(`${added.stderr}${rotated.stderr}`).not.toMatch(/v1|v2/)
  })

  it('audits every reveal, by name and never by value', () => {
    run(['secrets', 'add', 'audited'], 'hunter2-value\n')
    const shown = run(['secrets', 'show', 'audited', '--reveal'])
    expect(shown.status).toBe(0)
    expect(shown.stdout.trim()).toBe('hunter2-value')
    expect(run(['secrets', 'show', 'missing', '--reveal']).status).toBe(1)
    const db = new Database(join(home, 'foreman.db'), { readonly: true })
    const rows = db
      .prepare("select payload from audit_events where event_type = 'secret:revealed' order by id")
      .all() as Array<{ payload: string }>
    db.close()
    expect(rows.map((r) => JSON.parse(r.payload))).toEqual([
      { name: 'audited', ok: true, via: 'cli' },
      { name: 'missing', ok: false, via: 'cli' },
    ])
    expect(rows.map((r) => r.payload).join('')).not.toContain('hunter2')
  })
})
