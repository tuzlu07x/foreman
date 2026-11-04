import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

describe('foreman org (CLI)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}, input = '') =>
    spawnSync('node', [FM_BIN, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf-8', input })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-org-cli-'))
    env = { ...process.env, FOREMAN_HOME: home, FOREMAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }
    run(['init'])
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('init → show → validate → check', () => {
    const init = run(['org', 'init', '--template', 'startup', '--company', 'Acme'])
    expect(init.status).toBe(0)
    expect(init.stdout).toContain('Acme')

    const show = run(['org', 'show'])
    expect(show.stdout).toMatch(/cto · CTO/)
    expect(show.stdout).toMatch(/engineer · Software Engineer/)
    expect(show.stdout).toContain('mcp: github, filesystem, playwright, sentry')

    const validate = run(['org', 'validate'])
    expect(validate.status).toBe(0)
    expect(validate.stdout).toContain('org.yaml valid')

    const blocked = run(['org', 'check', 'codex', 'openclaw'])
    expect(blocked.status).toBe(1)
    expect(blocked.stdout).toContain('blocked')
    expect(run(['org', 'check', 'claude-code', 'codex']).stdout).toContain('allowed')
  })

  it('refuses to overwrite org.yaml without --force', () => {
    run(['org', 'init'])
    const again = run(['org', 'init'])
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('--force')
  })

  it('builds a team from nothing, role by role, the first one reporting to you', () => {
    const first = run(['org', 'add-role', 'manager', '--preset', 'manager', '--agent', 'claude-code', '--company', 'Acme'])
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('reporting to human')
    expect(run(['org', 'validate']).stdout).toContain('1 role, 0 departments')

    // No department yet: the Manager, as in the wizard and on the Team page.
    const head = run(['org', 'add-role', 'backend', '--preset', 'backend-developer', '--agent', 'codex'])
    expect(head.stdout).toContain('reporting to manager')
    expect(run(['org', 'add-department', 'it', '--name', 'IT', '--head', 'backend']).status).toBe(0)
    expect(run(['org', 'add-role', 'frontend', '--agent', 'codex', '--department', 'it']).stdout).toContain('reporting to backend')
    // A new head reports to the Manager too; saying otherwise still works.
    expect(run(['org', 'add-department', 'sales', '--head', 'cso', '--agent', 'hermes']).status).toBe(0)
    const yaml = readFileSync(join(home, 'org.yaml'), 'utf-8')
    expect(parseYaml(yaml).roles.cso.reports_to).toBe('manager')
    expect(run(['org', 'add-role', 'advisor', '--agent', 'hermes', '--reports-to', 'human']).stdout).toContain('reporting to human')

    expect(yaml).toContain('company: "Acme"')
    // Block style, so the file stays easy to edit by hand.
    expect(yaml).toMatch(/^departments:\n {2}it:\n/m)
    expect(run(['org', 'validate']).status).toBe(0)
  })

  it('a department can start the chart too', () => {
    const res = run(['org', 'add-department', 'it', '--head', 'cto', '--agent', 'claude-code'])
    expect(res.status, res.stderr).toBe(0)
    expect(parseYaml(readFileSync(join(home, 'org.yaml'), 'utf-8')).roles.cto.reports_to).toBe('human')
  })

  it('a role that fails to validate leaves no half-made org.yaml behind', () => {
    const res = run(['org', 'add-role', 'first', '--agent', 'codex', '--reports-to', 'nobody'])
    expect(res.status).toBe(1)
    expect(existsSync(join(home, 'org.yaml'))).toBe(false)
  })

  it('other org commands say how to start', () => {
    const res = run(['org', 'show'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('foreman org add-role')
  })

  it('a Foreman-spawned agent cannot delegate outside its chain via `foreman write`', () => {
    run(['org', 'init', '--template', 'startup'])
    // Register the target (write targets must exist).
    run(['agent', 'add', 'openclaw', '--type', 'generic-mcp', '--skip-config'])
    const fromAgent = run(['write', 'openclaw', 'post the launch thread'], { FOREMAN_SPAWNED_BY: 'codex' })
    expect(fromAgent.status).toBe(2)
    expect(fromAgent.stderr).toContain('blocked by the org chart')
    const fromHuman = run(['write', 'openclaw', 'post the launch thread'])
    expect(fromHuman.status).toBe(0)
  })
})
