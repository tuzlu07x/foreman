import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

  it('a Foreman-spawned agent cannot delegate outside its chain via `foreman write`', () => {
    run(['org', 'init', '--template', 'startup'])
    // Register the target the way an agent's first MCP connection does.
    run(['mcp-stdio', '--source', 'openclaw'])
    const fromAgent = run(['write', 'openclaw', 'post the launch thread'], { FOREMAN_SPAWNED_BY: 'codex' })
    expect(fromAgent.status).toBe(2)
    expect(fromAgent.stderr).toContain('blocked by the org chart')
    const fromHuman = run(['write', 'openclaw', 'post the launch thread'])
    expect(fromHuman.status).toBe(0)
  })
})
