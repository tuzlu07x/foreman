import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KNOWN_CHANNELS,
  isKnownChannel,
} from '../../src/core/notification/types.js'

// =============================================================================
// Regression for #264 — notify enable / test must validate the channel id
// against KNOWN_CHANNELS before any state change. Previously `enable bogus`
// succeeded with exit 0 and wrote garbage to notify.yaml; `test bogus` told
// the user to "enable bogus first" in a misleading loop.
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

describe('isKnownChannel + KNOWN_CHANNELS', () => {
  it('accepts every channel in the canonical set', () => {
    for (const c of KNOWN_CHANNELS) {
      expect(isKnownChannel(c)).toBe(true)
    }
  })

  it('rejects typos and unrelated strings', () => {
    expect(isKnownChannel('bogus')).toBe(false)
    expect(isKnownChannel('Telegram')).toBe(false) // case-sensitive
    expect(isKnownChannel('')).toBe(false)
  })
})

describe('foreman notify enable — channel validation (#264)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-ne-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-ne-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('rejects unknown channel ids with exit 1 and lists the valid set', () => {
    const r = runFm(['notify', 'enable', 'bogus'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('unknown channel "bogus"')
    for (const c of KNOWN_CHANNELS) {
      expect(r.stderr).toContain(c)
    }
  })

  it('does NOT write garbage to notify.yaml when the channel is invalid', () => {
    runFm(['notify', 'enable', 'bogus'], env)
    const path = join(tmpHome, 'notify.yaml')
    if (existsSync(path)) {
      const yaml = readFileSync(path, 'utf-8')
      expect(yaml).not.toContain('bogus')
    }
  })

  it('accepts every valid channel id with exit 0', () => {
    for (const c of KNOWN_CHANNELS) {
      const r = runFm(['notify', 'enable', c], env)
      expect(r.exit, `${c} should succeed`).toBe(0)
      expect(r.stdout).toContain(`${c} enabled`)
    }
  })
})

describe('foreman notify test — channel validation (#264)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-nt-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-nt-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('rejects unknown channel with the same "unknown channel" message as enable', () => {
    const r = runFm(['notify', 'test', 'bogus'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('unknown channel "bogus"')
  })

  it('does NOT suggest enabling a channel that does not exist', () => {
    const r = runFm(['notify', 'test', 'bogus'], env)
    expect(r.stderr).not.toMatch(/notify enable bogus/i)
  })
})
