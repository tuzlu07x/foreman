import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #268 — interactive policy commands (`reset`, `edit`) must
// not silently auto-cancel or launch an editor against a non-TTY pipe.
// Same shape as the #260 fix for secrets remove.
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

describe('foreman policy reset — non-TTY behaviour (#268)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-pol-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-pol-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses to reset in non-TTY without --yes (exit 1)', () => {
    const originalYaml = readFileSync(join(tmpHome, 'policy.yaml'), 'utf-8')
    // Tamper with policy.yaml so we can detect whether reset actually ran.
    writeFileSync(join(tmpHome, 'policy.yaml'), '# tampered\n')

    const r = runFm(['policy', 'reset'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('refusing to reset policy.yaml')
    expect(r.stderr).toContain('--yes')

    // File still tampered — reset did NOT run.
    expect(readFileSync(join(tmpHome, 'policy.yaml'), 'utf-8')).toBe(
      '# tampered\n',
    )
    void originalYaml // unused but documents intent
  })

  it('resets cleanly with --yes', () => {
    writeFileSync(join(tmpHome, 'policy.yaml'), '# tampered\n')

    const r = runFm(['policy', 'reset', '--yes'], env)
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('reset to template')

    const restored = readFileSync(join(tmpHome, 'policy.yaml'), 'utf-8')
    expect(restored).not.toBe('# tampered\n')
    expect(restored).toContain('rules:')
  })
})

describe('foreman policy edit — non-TTY refusal (#268)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-pe-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-pe-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses with exit 1 and suggests the file path', () => {
    const r = runFm(['policy', 'edit'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('requires an interactive terminal')
    expect(r.stderr).toContain(join(tmpHome, 'policy.yaml'))
  })

  it('does NOT dump editor escape codes into stdout', () => {
    const r = runFm(['policy', 'edit'], env)
    // Vim's escape codes look like \x1b[ followed by digits. We refuse before
    // launching the editor, so nothing should slip through.
    expect(r.stdout).not.toMatch(/\x1b\[/)
  })
})
