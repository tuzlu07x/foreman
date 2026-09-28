import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDirs } from '../../src/utils/config.js'
import { stubInstallers } from '../support/stub-installers.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

interface Check {
  name: string
  status: 'ok' | 'warn' | 'fail'
  message: string
}

// QA #657 M13 — a fresh box got six doctor warnings (three for ACP agents
// nobody registered, a false legacy_home), and the suggested
// `migrate-config` doubled the path; with --force it "moved" the live
// files onto themselves and suggested removing the live home.
describe('doctor on a fresh box with FOREMAN_HOME=~/.foreman', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  const home = () => join(dir, 'home')
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-fresh-doctor-'))
    mkdirSync(home())
    env = {
      HOME: home(),
      FOREMAN_HOME: join(home(), '.foreman'),
      XDG_CONFIG_HOME: join(dir, 'xdgc'),
      XDG_STATE_HOME: join(dir, 'xdgs'),
      XDG_CACHE_HOME: join(dir, 'xdgcache'),
      TMPDIR: dir,
      PATH: stubInstallers(dir).path,
      NO_COLOR: '1',
      FOREMAN_NO_UPDATE_CHECK: '1',
    }
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('has no ACP or legacy_home warnings', () => {
    const checks = (JSON.parse(run('doctor', '--json').stdout) as { checks: Check[] }).checks
    expect(checks.filter((c) => c.name.startsWith('acp')).map((c) => c.status)).toEqual(['ok'])
    expect(checks.find((c) => c.name === 'legacy_home')?.status).toBe('ok')
  })

  it('migrate-config --force leaves the live home alone', () => {
    const policy = join(home(), '.foreman', 'policy.yaml')
    const before = readFileSync(policy, 'utf-8')
    const out = run('migrate-config', '--force')
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('is the home Foreman uses now')
    expect(out.stdout).not.toContain('rmdir')
    expect(out.stdout).not.toContain('migrated')
    expect(readFileSync(policy, 'utf-8')).toBe(before)
  })

  it('names the files already in the new layout, without doubling paths', () => {
    // A real legacy home next to a live new layout (XDG on Linux,
    // ~/Library/Application Support on macOS, which ignores XDG_*).
    delete env.FOREMAN_HOME
    mkdirSync(join(home(), '.foreman'), { recursive: true })
    writeFileSync(join(home(), '.foreman', 'policy.yaml'), 'rules: []\n')
    const { configDir } = resolveDirs({ homeDir: home(), env })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'policy.yaml'), 'rules: []\n')
    const out = run('migrate-config')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain(`the new layout already has data: ${join(configDir, 'policy.yaml')}`)
    expect(out.stderr).not.toMatch(/foreman\/\//)
  })
})
