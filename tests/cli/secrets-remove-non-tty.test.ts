import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #260 — `secrets remove` in non-TTY contexts must:
//   1. Validate the secret exists BEFORE prompting (so non-existent secrets
//      error loudly instead of being masked by the silent-cancel).
//   2. Refuse to silently cancel when stdin isn't a TTY; require --yes.
//   3. Still happily remove with --yes.
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

function runFm(
  args: string[],
  env: NodeJS.ProcessEnv,
): RunResult {
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

describe('secrets remove — non-TTY behaviour (#260)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-rm-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-rm-h-'))
    env = {
      ...process.env,
      FOREMAN_HOME: tmpHome,
      HOME: fakeHome,
    }
    runFm(['init'], env)
    runFm(['secrets', 'add', 'qa', '--value', 'val'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('errors with exit 1 when the secret does not exist (no --yes)', () => {
    const r = runFm(['secrets', 'remove', 'never-existed'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('no secret named "never-existed"')
  })

  it('refuses to remove an existing secret without --yes in non-TTY', () => {
    const r = runFm(['secrets', 'remove', 'qa'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('non-interactive')
    expect(r.stderr).toContain('--yes')

    // Confirm the secret is still there.
    const ls = runFm(['secrets', 'list'], env)
    expect(ls.stdout).toContain('qa')
  })

  it('removes cleanly with --yes', () => {
    const r = runFm(['secrets', 'remove', 'qa', '--yes'], env)
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('removed secret "qa"')

    const ls = runFm(['secrets', 'list'], env)
    expect(ls.stdout).toContain('(no secrets stored)')
  })

  it('errors with exit 1 when --yes is set but the secret does not exist', () => {
    const r = runFm(['secrets', 'remove', 'never-existed', '--yes'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('no secret named "never-existed"')
  })
})
