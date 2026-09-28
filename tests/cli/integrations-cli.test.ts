import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// `foreman integrations` end to end, in a throwaway home. Nothing here
// touches the network: every add passes --no-review / --no-login.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')
const PAT = `ghp_${'A'.repeat(36)}`
const PAT2 = `ghp_${'B'.repeat(36)}`

describe('foreman integrations', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  const run = (args: string[], input?: string) =>
    spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8', ...(input !== undefined ? { input } : {}) })
  const home = () => join(dir, 'fh')
  const auditEvents = (): Array<{ type: string; payload: string }> => {
    const db = new Database(join(home(), 'foreman.db'), { readonly: true })
    try {
      return db
        .prepare("SELECT event_type AS type, payload FROM audit_events WHERE event_type LIKE 'integration:%' ORDER BY id")
        .all() as Array<{ type: string; payload: string }>
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-int-cli-'))
    mkdirSync(join(dir, 'home'))
    env = {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      FOREMAN_HOME: home(),
      FOREMAN_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    }
    expect(run(['init']).status).toBe(0)
    for (const agent of ['claude-code', 'codex']) run(['agent', 'add', agent, '--skip-config'])
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists the catalog', () => {
    const out = run(['integrations', 'catalog', '--json'])
    expect(out.status).toBe(0)
    const ids = (JSON.parse(out.stdout) as Array<{ id: string }>).map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['github', 'gitlab', 'atlassian', 'trello', 'linear', 'notion']))
  })

  it('adds GitHub disabled, keeps the token out of mcp.yaml and the audit log, and refuses to enable it unreviewed', () => {
    const add = run(['integrations', 'add', 'gh', '--token-stdin', '--agents', 'claude-code', '--no-review'], `${PAT}\n`)
    expect(add.status, add.stderr).toBe(0)
    expect(add.stdout).toContain('saved github (disabled)')
    const yaml = readFileSync(join(home(), 'mcp.yaml'), 'utf-8')
    expect(yaml).not.toContain(PAT)
    expect(yaml).toContain('${secret:github-pat}')

    const list = JSON.parse(run(['integrations', 'list', '--json']).stdout) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'github', enabled: false, access_level: 'read-only', access: { agents: ['claude-code'] } })

    const show = JSON.parse(run(['integrations', 'show', 'github', '--json']).stdout) as { agents: Array<{ agent: string; allowed: boolean }> }
    expect(show.agents).toEqual(
      expect.arrayContaining([
        { agent: 'claude-code', allowed: true },
        { agent: 'codex', allowed: false },
      ]),
    )

    const enable = run(['integrations', 'enable', 'github'])
    expect(enable.status).toBe(1)
    expect(enable.stdout).toMatch(/stays disabled/)
    expect(enable.stdout).toMatch(/not been reviewed/)

    const events = auditEvents()
    expect(events.map((e) => e.type)).toEqual(['integration:added'])
    expect(JSON.stringify(events)).not.toContain(PAT)
  }, 60_000)

  it('refuses a malformed token without echoing it, and needs an explicit audience off a terminal', () => {
    const bad = run(['integrations', 'add', 'github', '--token-stdin', '--all-agents', '--no-review'], 'nope-SECRET-VALUE\n')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/doesn't look like a valid/)
    expect(bad.stderr + bad.stdout).not.toContain('SECRET-VALUE')
    const noAudience = run(['integrations', 'add', 'linear', '--no-login'], '')
    expect(noAudience.status).toBe(1)
    expect(noAudience.stderr).toMatch(/--agents <ids>, --departments <ids> or --all-agents/)
  }, 60_000)

  it('updates the access level and several tool rules, and says when a rule has no effect', () => {
    run(['integrations', 'add', 'github', '--token-stdin', '--all-agents', '--no-review'], `${PAT}\n`)
    const out = run([
      'integrations',
      'update',
      'github',
      '--read-write',
      '--tool',
      'get_me=deny',
      '--tool',
      'merge_pull_request=allow',
    ])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/merge_pull_request: your 'allow' has no effect — the catalog's 'confirm' is stronger/)
    const yaml = readFileSync(join(home(), 'mcp.yaml'), 'utf-8')
    expect(yaml).toMatch(/access_level: read-write/)
    expect(yaml).toMatch(/get_me/)
  }, 60_000)

  it('keeps a second account apart and asks which one an ambiguous name means', () => {
    run(['integrations', 'add', 'github', '--token-stdin', '--all-agents', '--no-review'], `${PAT}\n`)
    const second = run(
      ['integrations', 'add', 'github', '--name', 'github-work', '--token-stdin', '--agents', 'codex', '--no-review'],
      `${PAT2}\n`,
    )
    expect(second.status, second.stderr).toBe(0)
    expect(readFileSync(join(home(), 'mcp.yaml'), 'utf-8')).toContain('${secret:github-pat-work}')
    const ambiguous = run(['integrations', 'show', 'gh'])
    expect(ambiguous.status).toBe(1)
    expect(ambiguous.stderr).toMatch(/github, github-work — which one\?/)
  }, 60_000)

  it('removes only with --yes off a terminal, and deletes only its own credential', () => {
    run(['integrations', 'add', 'github', '--token-stdin', '--all-agents', '--no-review'], `${PAT}\n`)
    run(['integrations', 'add', 'github', '--name', 'github-work', '--token-stdin', '--all-agents', '--no-review'], `${PAT2}\n`)
    expect(run(['integrations', 'remove', 'github-work'], '').status).toBe(1)
    const removed = run(['integrations', 'remove', 'github-work', '--yes'])
    expect(removed.status, removed.stderr).toBe(0)
    expect(removed.stdout).toContain('deleted: github-pat-work')
    expect(removed.stdout).toMatch(/revoke Foreman's access at the provider/)
    const secrets = run(['secrets', 'list']).stdout
    expect(secrets).toContain('github-pat')
    expect(secrets).not.toContain('github-pat-work')
    expect(auditEvents().map((e) => e.type)).toContain('integration:removed')
  }, 60_000)

  it('adopts a server added with foreman mcp add', () => {
    expect(run(['mcp', 'add', 'notion']).status).toBe(0)
    const adopt = run(['integrations', 'adopt', 'notion', '--id', 'notion', '--agents', 'codex'])
    expect(adopt.status, adopt.stderr).toBe(0)
    const list = JSON.parse(run(['integrations', 'list', '--json']).stdout) as Array<Record<string, unknown>>
    expect(list[0]).toMatchObject({ name: 'notion', integration: 'notion', variant: 'token', access: { agents: ['codex'] } })
    expect(run(['integrations', 'adopt', 'notion', '--id', 'notion', '--all-agents']).stderr).toMatch(/already an integration/)
  }, 60_000)

  it('warns before removing a secret an integration uses, and doctor names an enabled one that cannot work', () => {
    run(['integrations', 'add', 'github', '--token-stdin', '--all-agents', '--no-review'], `${PAT}\n`)
    const rm = run(['secrets', 'remove', 'github-pat'], '')
    expect(rm.stderr).toMatch(/github uses "github-pat"/)
    expect(run(['integrations', 'enable', 'github', '--force']).status).toBe(0)
    const doctor = JSON.parse(run(['doctor', '--json']).stdout) as { checks: Array<{ name: string; status: string; message: string }> }
    const check = doctor.checks.find((c) => c.name === 'integrations')!
    expect(check.status).toBe('warn')
    expect(check.message).toMatch(/github: not-reviewed/)
  }, 60_000)
})
