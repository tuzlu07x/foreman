import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRegistryText } from '../../src/core/registry-catalog.js'

// =============================================================================
// Regression for #270 — `foreman registry validate` must:
//   1. Reference the actual file path in error messages (was hardcoded
//      "registry/agents.json").
//   2. Print a friendly "file not found" line instead of a raw ENOENT.
//   3. Exit 1 on every error path (was hard to verify from CLI logs — Bash
//      $? capture in shell loops is unreliable, so we spawn explicitly).
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

describe('parseRegistryText — source path in error messages (#270)', () => {
  it('references the supplied source in the JSON-parse error', () => {
    expect(() => parseRegistryText('{ broken', '/tmp/qa.json')).toThrow(
      /\/tmp\/qa\.json is not valid JSON/,
    )
  })

  it('references the supplied source in the schema-fail error', () => {
    expect(() =>
      parseRegistryText('{"version":1,"agents":[{}]}', '/tmp/qa.json'),
    ).toThrow(/\/tmp\/qa\.json failed schema validation/)
  })

  it('defaults to the historical "registry/agents.json" literal when no source given', () => {
    expect(() => parseRegistryText('{ broken')).toThrow(
      /registry\/agents\.json is not valid JSON/,
    )
  })
})

describe('foreman registry validate — CLI (#270)', () => {
  let tmpHome: string
  let fakeHome: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-rv-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'foreman-rv-h-'))
    env = { ...process.env, FOREMAN_HOME: tmpHome, HOME: fakeHome }
    runFm(['init'], env)
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('exit 0 + "registry valid" on the bundled registry (no path)', () => {
    const r = runFm(['registry', 'validate'], env)
    expect(r.exit).toBe(0)
    expect(r.stdout).toMatch(/registry valid — \d+ agents/)
  })

  it('exit 1 + actual path in message on malformed JSON', () => {
    const badPath = join(tmpHome, 'bad.json')
    writeFileSync(badPath, '{ "broken": true')
    const r = runFm(['registry', 'validate', badPath], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain(badPath)
    expect(r.stderr).toContain('is not valid JSON')
    expect(r.stderr).not.toContain('registry/agents.json')
  })

  it('exit 1 + actual path in message on schema failure', () => {
    const badPath = join(tmpHome, 'schema-bad.json')
    writeFileSync(badPath, '{"version":1,"agents":[{"id":"X"}]}')
    const r = runFm(['registry', 'validate', badPath], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain(badPath)
    expect(r.stderr).toContain('failed schema validation')
    expect(r.stderr).not.toContain('registry/agents.json failed')
  })

  it('exit 1 + friendly "file not found" on ENOENT (no raw Node error)', () => {
    const r = runFm(['registry', 'validate', '/nonexistent.json'], env)
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('file not found: /nonexistent.json')
    expect(r.stderr).not.toContain('ENOENT')
  })
})
