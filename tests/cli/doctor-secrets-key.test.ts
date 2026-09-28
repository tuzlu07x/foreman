import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

interface Check {
  name: string
  status: 'ok' | 'warn' | 'fail'
  message: string
  remediation?: string
}

// QA #657 M9 — doctor silently minted a new secrets.key, which hid a lost
// key: every stored secret was undecryptable afterwards, and `secrets show
// --reveal` died with an EncryptionError stack.
describe('doctor and a lost secrets.key', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const keyPath = () => join(home, 'secrets.key')
  const run = (args: string[], input?: string) =>
    spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8', ...(input !== undefined ? { input } : {}) })
  const doctor = (): Check[] => (JSON.parse(run(['doctor', '--json']).stdout) as { checks: Check[] }).checks
  const check = (name: string): Check | undefined => doctor().find((c) => c.name === name)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-doctor-key-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1', FOREMAN_NO_UPDATE_CHECK: '1' }
    expect(run(['init']).status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('init creates secrets.key', () => {
    expect(existsSync(keyPath())).toBe(true)
  })

  it('doctor never creates secrets.key', () => {
    rmSync(keyPath())
    expect(check('secrets_key')?.status).toBe('ok')
    expect(existsSync(keyPath())).toBe(false)
  })

  it('fails loudly when secrets are stored and the key is gone, and still creates nothing', () => {
    expect(run(['secrets', 'add', 'anthropic-key'], 'sk-ant-fake-value\n').status).toBe(0)
    renameSync(keyPath(), join(home, 'secrets.key.moved'))
    const out = run(['doctor', '--json'])
    expect(out.status).toBe(2)
    const row = (JSON.parse(out.stdout) as { checks: Check[] }).checks.find((c) => c.name === 'secrets_key')
    expect(row?.status).toBe('fail')
    expect(row?.message).toBe("secrets.key is missing — 1 stored secret can't be decrypted")
    expect(row?.remediation).toContain(`Restore secrets.key from your backup to ${keyPath()}`)
    expect(existsSync(keyPath())).toBe(false)
    // Re-running init doesn't mint a new key over them either.
    const init = run(['init'])
    expect(init.stdout).toContain("1 stored secret can't be decrypted")
    expect(existsSync(keyPath())).toBe(false)
  })

  it('fails when the key is the wrong one, and secrets show says why without a stack', () => {
    expect(run(['secrets', 'add', 'anthropic-key'], 'sk-ant-fake-value\n').status).toBe(0)
    writeFileSync(keyPath(), randomBytes(32), { mode: 0o600 })
    const row = check('secrets_key')
    expect(row?.status).toBe('fail')
    expect(row?.message).toContain("secrets.key can't decrypt 1 of 1 stored secret")
    const show = run(['secrets', 'show', 'anthropic-key', '--reveal'])
    expect(show.status).toBe(1)
    expect(show.stderr).toContain(`error: can't decrypt secret "anthropic-key": secrets.key isn't the key it was stored with`)
    expect(show.stderr).not.toMatch(/EncryptionError|at .*\.js:\d+/)
  })

  it('passes with the right key', () => {
    expect(run(['secrets', 'add', 'anthropic-key'], 'sk-ant-fake-value\n').status).toBe(0)
    expect(check('secrets_key')).toMatchObject({ status: 'ok', message: 'decrypts all 1 stored secret' })
  })
})
