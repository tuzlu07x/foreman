import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #278 — `foreman start` must refuse non-TTY upfront. Previously
// rendering the Ink TUI against a pipe dumped 271 lines of garbled boot
// banner + hung forever (no exit signal, no Ctrl-C in CI).
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
      // Belt-and-braces: kill after 10s so a regression that re-introduces
      // the hang fails the test instead of stalling the suite.
      timeout: 10_000,
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

describe('foreman start — non-TTY guard (#278)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-start-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-start-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('exits 1 with a friendly error when stdout is a pipe', () => {
    const r = runFm(['start'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('requires an interactive terminal')
    expect(r.stderr).toContain('TUI cannot render to a pipe')
  })

  it('suggests scripted alternatives (mcp-stdio + wrap)', () => {
    const r = runFm(['start'], env)
    expect(r.stderr).toContain('foreman mcp-stdio')
    expect(r.stderr).toContain('foreman wrap')
  })

  it('does NOT dump the boot banner into stdout', () => {
    const r = runFm(['start'], env)
    // The old behaviour emitted ~271 lines of garbled wordmark / banner.
    // After the fix the only output is the friendly error on stderr.
    expect(r.stdout).toBe('')
  })

  it('refuses fast (no hang) — completes well under the 10s timeout', () => {
    // execFileSync above has `timeout: 10_000`. If the process hangs the
    // call throws with ETIMEDOUT / status null; r.exit captures that.
    const start = Date.now()
    runFm(['start'], env)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5_000)
  })

  it('still refuses even with --no-onboarding (the guard runs before any onboarding logic)', () => {
    const r = runFm(['start', '--no-onboarding'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('requires an interactive terminal')
  })

  it('still refuses with --skip-setup', () => {
    const r = runFm(['start', '--skip-setup'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('requires an interactive terminal')
  })
})
