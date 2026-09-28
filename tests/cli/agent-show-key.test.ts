import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stubInstallers } from '../support/stub-installers.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA: `foreman agent show` printed no public key, so an operator couldn't
// check which keypair an agent holds (e.g. after `regenerate-key`).
describe('foreman agent show — public key', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-agent-key-'))
    env = { HOME: join(dir, 'home'), FOREMAN_HOME: join(dir, 'fh'), TMPDIR: dir, PATH: stubInstallers(dir).path, NO_COLOR: '1', FOREMAN_NO_UPDATE_CHECK: '1' }
    expect(run('init').status).toBe(0)
    expect(run('agent', 'add', 'my-mcp', '--type', 'generic-mcp').status).toBe(0)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('--json carries the public key in hex and its fingerprint, and nothing private', () => {
    const res = run('agent', 'show', 'my-mcp', '--json')
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout) as Record<string, unknown>
    expect(out.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(out.publicKeyFingerprint).toBe(`ed25519:${(out.publicKey as string).slice(0, 8)}`)
    expect(res.stdout).not.toMatch(/private/i)
  })

  it('text output shows the fingerprint in the style foreman init uses', () => {
    const json = JSON.parse(run('agent', 'show', 'my-mcp', '--json').stdout) as { publicKey: string }
    const res = run('agent', 'show', 'my-mcp')
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(new RegExp(`key:\\s+ed25519:${json.publicKey.slice(0, 8)}…`))
    expect(res.stdout).not.toContain(json.publicKey)
  })

  it('shows the new key after regenerate-key', () => {
    const before = JSON.parse(run('agent', 'show', 'my-mcp', '--json').stdout) as { publicKey: string }
    expect(run('agent', 'regenerate-key', 'my-mcp', '--yes', '--out', join(dir, 'my-mcp.key')).status).toBe(0)
    const after = JSON.parse(run('agent', 'show', 'my-mcp', '--json').stdout) as { publicKey: string }
    expect(after.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(after.publicKey).not.toBe(before.publicKey)
  })
})
