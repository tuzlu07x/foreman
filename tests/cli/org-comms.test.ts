import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// #630 — map channels, post as the owner, read everything from the CLI.

describe('foreman org channel / tell / messages (#630)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-org-comms-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
    expect(run('org', 'init', '--template', 'startup', '--company', 'Acme').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('maps departments and company channels to Slack / Discord, and removes them', () => {
    expect(run('org', 'channel', 'marketing', 'slack', '#marketing').stdout).toContain('#marketing → slack #marketing')
    expect(run('org', 'channel', 'all', 'discord', '123456789012345678').status).toBe(0)
    expect(run('org', 'channel', 'direct', 'slack', '#agent-threads').stdout).toContain('role-to-role threads')
    const yaml = readFileSync(join(home, 'org.yaml'), 'utf-8')
    expect(yaml).toMatch(/channels:\n\s+slack: "#marketing"/)
    expect(run('org', 'channel', 'marketing').stdout).toContain('marketing → slack #marketing')
    expect(run('org', 'channel', 'nowhere', 'slack', '#x').status).toBe(1)
    expect(run('org', 'channel', 'marketing', 'slack', 'off').status).toBe(0)
    expect(readFileSync(join(home, 'org.yaml'), 'utf-8')).not.toContain('#marketing')
  })

  it('posts as you and reads it back', () => {
    const told = run('org', 'tell', 'marketing', 'launch', 'is', 'Friday')
    expect(told.status).toBe(0)
    expect(told.stdout).toContain('posted to #marketing')
    expect(run('org', 'tell', 'all', 'welcome', 'aboard').status).toBe(0)
    const messages = run('org', 'messages')
    expect(messages.stdout).toContain('#marketing · you: launch is Friday')
    expect(messages.stdout).toContain('#all-hands · you [announcement]: welcome aboard')
    expect(run('org', 'messages', 'marketing').stdout).not.toContain('welcome aboard')
    expect(run('org', 'tell', 'legal', 'x').stderr).toContain("no department, role or agent called 'legal'")
  })
})
