import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #266 — notify summary --hours must reject NaN / 0 / negative
// / absurdly-large values before generateSummary builds its window string
// (previously: "last NaN minutes", "last -60 minutes", "last 4167 days").
// =============================================================================

const FM_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
  'dist/cli/index.js',
)

interface RunResult {
  stdout: string
  stderr: string
  exit: number
}

function runFm(args: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    const stdout = execFileSync('node', [FM_BIN, ...args], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exit: 0 }
  } catch (err) {
    const e = err as {
      status: number
      stdout?: string | Buffer
      stderr?: string | Buffer
    }
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exit: e.status,
    }
  }
}

describe('foreman notify summary --hours validation (#266)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-summary-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-summary-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  // Note: "12.5" → parseInt("12.5", 10) → 12, which we treat as a valid
  // integer. Same forgiveness commander/parseInt gives; "the user meant 12".
  const badValues = ['notanumber', '0', '-1', '99999'] as const

  it.each(badValues)('rejects --hours %s with exit 1 + friendly error', (v) => {
    const r = runFm(['notify', 'summary', '--hours', v], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('--hours must be an integer between 1 and 8760')
    expect(r.stdout).not.toContain('Foreman summary')
  })

  const goodValues = ['1', '12', '24', '168', '8760'] as const

  it.each(goodValues)('accepts --hours %s with exit 0 + builds the digest', (v) => {
    const r = runFm(['notify', 'summary', '--hours', v], env)
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('Foreman summary')
  })

  it('default (no --hours) still works, 12-hour window', () => {
    const r = runFm(['notify', 'summary'], env)
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('last 12 hours')
  })
})
