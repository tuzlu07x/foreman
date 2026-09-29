import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// `foreman agent add` used to print the agent's private key "once, store it
// now"; in the real-services test it was pasted straight into a chat.
// Nothing in Foreman needs it, so it is only written with --key-out.

const FM_BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'dist/cli/index.js')

describe('foreman agent add: the private key', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fm-keyout-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [FM_BIN, ...args], {
      env: { ...process.env, FOREMAN_HOME: join(home, 'f'), HOME: home, NO_COLOR: '1', FOREMAN_NO_UPDATE_CHECK: '1' },
      encoding: 'utf-8',
    })

  it('never prints it, and says how to keep it', () => {
    expect(run('init').status).toBe(0)
    const r = run('agent', 'add', 'generic-mcp', '--skip-config', '--token-out', join(home, 'token'))
    expect(r.status, r.stderr).toBe(0)
    const out = r.stdout + r.stderr
    expect(out).not.toMatch(/\b[0-9a-f]{64}\b/)
    expect(out).toContain("the private key isn't shown (save it with --key-out <file> if you need it)")
  })

  it('writes it 0600 with --key-out', () => {
    expect(run('init').status).toBe(0)
    const keyFile = join(home, 'agent.key')
    const r = run('agent', 'add', 'generic-mcp', '--skip-config', '--token-out', join(home, 'token'), '--key-out', keyFile)
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(keyFile)).toBe(true)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(keyFile).length).toBeGreaterThan(0)
    expect(r.stdout + r.stderr).not.toContain(readFileSync(keyFile).toString('hex'))
  })
})
