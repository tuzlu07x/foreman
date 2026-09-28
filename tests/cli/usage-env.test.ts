import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 L28 — `usage env` printed the same usage key for every agent.
describe('foreman usage env', () => {
  let home: string
  const run = (...args: string[]) =>
    spawnSync('node', [FM_BIN, ...args], { env: { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }, encoding: 'utf-8' })
  const keyIn = (text: string): string | undefined => /x-foreman-usage-key"? ?=? ?"?([^\s",}]+)/.exec(text)?.[1]
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-usage-env-'))
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('gives each agent a key of its own', () => {
    const claude = keyIn(run('usage', 'env', 'claude-code').stdout)
    const hermes = keyIn(run('usage', 'env', 'hermes').stdout)
    const codex = keyIn(run('usage', 'env', 'codex').stdout)
    expect(claude).toMatch(/^u1\.claude-code\.[0-9a-f]{64}$/)
    expect(hermes).toMatch(/^u1\.hermes\./)
    expect(codex).toMatch(/^u1\.codex\./)
    expect(new Set([claude, hermes, codex]).size).toBe(3)
    // Stable: the same agent gets the same key again.
    expect(keyIn(run('usage', 'env', 'claude-code').stdout)).toBe(claude)
  })
})
