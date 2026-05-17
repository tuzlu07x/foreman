import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #272 — destructive agent commands need confirmation.
//
// - regenerate-key had ZERO confirmation. Now requires interactive prompt
//   in TTY, --yes in non-TTY (otherwise refuse with exit 1).
// - remove fell through to silent "(cancelled)" + exit 0 in non-TTY without
//   --yes (same root cause as #260 / #268). Now refuses with exit 1.
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

describe('foreman agent — non-TTY confirmation guards (#272)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-an-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-an-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
    runFm(
      [
        'agent',
        'add',
        'qa',
        '--type',
        'claude-code',
        '--skip-config',
        '--skip-projection',
      ],
      env,
    )
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  describe('regenerate-key', () => {
    it('refuses in non-TTY without --yes (exit 1)', () => {
      const r = runFm(['agent', 'regenerate-key', 'qa'], env)
      expect(r.exit).toBe(1)
      expect(r.stderr).toContain('refusing to regenerate-key')
      expect(r.stderr).toContain('--yes')
    })

    it('rotates with --yes', () => {
      const r = runFm(['agent', 'regenerate-key', 'qa', '--yes'], env)
      expect(r.exit).toBe(0)
      expect(r.stdout).toContain('new private key')
      // Hex-encoded ed25519 private key is 64 chars.
      expect(r.stdout).toMatch(/[0-9a-f]{64}/)
    })

    it('errors with exit 1 when the agent does not exist (even with --yes)', () => {
      const r = runFm(['agent', 'regenerate-key', 'never-existed', '--yes'], env)
      expect(r.exit).toBe(1)
      expect(r.stderr).toContain('no agent with id never-existed')
    })

    it('still has --out option (not regressed)', () => {
      const out = join(tmpHome, 'newkey.bin')
      const r = runFm(
        ['agent', 'regenerate-key', 'qa', '--yes', '--out', out],
        env,
      )
      expect(r.exit).toBe(0)
      expect(r.stdout).toContain('written to')
    })
  })

  describe('remove', () => {
    it('refuses in non-TTY without --yes (exit 1)', () => {
      const r = runFm(['agent', 'remove', 'qa'], env)
      expect(r.exit).toBe(1)
      expect(r.stderr).toContain('refusing to remove "qa"')
      expect(r.stderr).toContain('--yes')

      // Agent still present.
      const ls = runFm(['agent', 'list'], env)
      expect(ls.stdout).toContain('qa')
    })

    it('removes cleanly with --yes', () => {
      const r = runFm(['agent', 'remove', 'qa', '--yes', '--keep-binary'], env)
      expect(r.exit).toBe(0)
      expect(r.stdout).toContain('agent qa removed')

      const ls = runFm(['agent', 'list'], env)
      expect(ls.stdout).toContain('(no agents registered)')
    })

    it('errors when the agent does not exist (even with --yes)', () => {
      const r = runFm(
        ['agent', 'remove', 'never-existed', '--yes', '--keep-binary'],
        env,
      )
      expect(r.exit).toBe(1)
      expect(r.stderr).toContain('no agent with id never-existed')
    })
  })
})
