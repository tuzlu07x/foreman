import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stubInstallers, type StubInstallers } from '../support/stub-installers.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 H5 — `foreman agent remove claude-code --yes` ran
// `npm uninstall -g @anthropic-ai/claude-code` although Foreman never
// installed it. Removing now unregisters only; uninstalling needs
// --uninstall, and only for a binary Foreman installed itself.
describe('foreman agent remove keeps the binary', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let stubs: StubInstallers
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  const uninstalls = () => stubs.calls().filter((c) => c.includes('uninstall'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-agent-remove-'))
    stubs = stubInstallers(dir)
    env = {
      HOME: join(dir, 'home'),
      FOREMAN_HOME: join(dir, 'fh'),
      TMPDIR: dir,
      PATH: stubs.path,
      NO_COLOR: '1',
      FOREMAN_NO_UPDATE_CHECK: '1',
    }
    expect(run('init').status).toBe(0)
    expect(run('agent', 'add', 'claude-code', '--type', 'claude-code', '--skip-config').status).toBe(0)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const markInstalledByForeman = (): void => {
    const db = new Database(join(dir, 'fh', 'foreman.db'))
    const row = db.prepare('SELECT metadata FROM agents WHERE id = ?').get('claude-code') as { metadata: string }
    const metadata = { ...JSON.parse(row.metadata), installedByForeman: { command: 'npm install -g @anthropic-ai/claude-code', at: 1 } }
    db.prepare('UPDATE agents SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), 'claude-code')
    db.close()
  }

  it('unregisters without uninstalling by default', () => {
    const out = run('agent', 'remove', 'claude-code', '--yes')
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('agent claude-code removed')
    expect(out.stdout).toContain('Claude Code is still installed')
    expect(uninstalls()).toEqual([])
    expect(run('agent', 'show', 'claude-code').status).not.toBe(0)
  })

  it('refuses --uninstall for a binary Foreman did not install, changing nothing', () => {
    const out = run('agent', 'remove', 'claude-code', '--uninstall', '--yes')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain("Foreman didn't install Claude Code")
    expect(out.stderr).toContain('npm uninstall -g @anthropic-ai/claude-code')
    expect(uninstalls()).toEqual([])
    expect(run('agent', 'show', 'claude-code').status).toBe(0)
  })

  it('uninstalls with --uninstall when Foreman installed it', () => {
    markInstalledByForeman()
    const out = run('agent', 'remove', 'claude-code', '--uninstall', '--yes')
    expect(out.stdout).toContain('agent claude-code removed')
    expect(uninstalls()).toEqual(['npm uninstall -g @anthropic-ai/claude-code'])
  })

  it('says what will happen in the non-interactive refusal and help', () => {
    const help = run('agent', 'remove', '--help')
    expect(help.stdout).toContain('--uninstall')
    expect(help.stdout).toContain('binary stays installed')
    expect(help.stdout).not.toContain('--keep-binary')
    // --keep-binary is still accepted (it is the default now).
    expect(run('agent', 'remove', 'claude-code', '--keep-binary', '--yes').status).toBe(0)
    expect(uninstalls()).toEqual([])
  })
})
