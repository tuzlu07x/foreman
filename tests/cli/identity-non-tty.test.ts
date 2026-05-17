import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #274 — fourth surface to get the standardised non-TTY guards
// (after #260 secrets, #268 policy, #272 agent). identity reset + identity
// edit are the destructive commands here.
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

describe('foreman identity reset — non-TTY (#274)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-ir-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-ir-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses non-TTY without --yes (exit 1) and leaves SOUL.md untouched', () => {
    const soulPath = join(tmpHome, 'SOUL.md')
    writeFileSync(soulPath, '# tampered identity\n')

    const r = runFm(['identity', 'reset'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('refusing to reset SOUL.md')
    expect(r.stderr).toContain('--yes')

    // File still tampered.
    expect(readFileSync(soulPath, 'utf-8')).toBe('# tampered identity\n')
  })

  it('resets cleanly with --yes', () => {
    const soulPath = join(tmpHome, 'SOUL.md')
    writeFileSync(soulPath, '# tampered identity\n')

    const r = runFm(['identity', 'reset', '--yes'], env)
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('reset to template')

    const restored = readFileSync(soulPath, 'utf-8')
    expect(restored).not.toBe('# tampered identity\n')
    expect(restored).toContain('Foreman')
  })
})

describe('foreman identity edit — non-TTY refusal (#274)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-ie-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-ie-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses with exit 1 and surfaces the file path', () => {
    const r = runFm(['identity', 'edit'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('requires an interactive terminal')
    expect(r.stderr).toContain(join(tmpHome, 'SOUL.md'))
  })

  it('does NOT dump editor escape codes into stdout', () => {
    const r = runFm(['identity', 'edit'], env)
    // Vim's escape codes look like \x1b[ followed by digits.
    expect(r.stdout).not.toMatch(/\x1b\[/)
  })
})
