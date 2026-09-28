import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { startForeman } from '../../src/cli/start.js'
import { bus } from '../../src/core/event-bus.js'
import { createMediatorStack } from '../../src/core/mediator-stack.js'
import { PolicyLoadError } from '../../src/core/policy-load.js'
import { DenyAllApprovalService } from '../../src/core/approval.js'
import { closeDb, createInMemoryDb } from '../../src/db/client.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 M4 — `- this is: [broken` in policy.yaml crashed `foreman start`
// with a raw YAMLParseError stack (exit 7).
describe('a broken policy.yaml', () => {
  let home: string
  let saved: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-policy-error-'))
    saved = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = home
    runInit()
  })
  afterEach(() => {
    closeDb()
    if (saved === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = saved
    rmSync(home, { recursive: true, force: true })
  })

  it('stops foreman start with file, line and reason, before anything starts', () => {
    appendFileSync(join(home, 'policy.yaml'), '- this is: [broken\n')
    let thrown: unknown
    try {
      startForeman({ withTui: false })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PolicyLoadError)
    const err = thrown as PolicyLoadError
    expect(err.path).toBe(join(home, 'policy.yaml'))
    expect(err.line).toBeGreaterThan(1)
    expect(err.message).toMatch(/policy\.yaml failed to parse \(line \d+\): /)
    expect(err.message).not.toContain('\n')
    // No pidfile: nothing was started.
    expect(existsSync(join(home, 'foreman.pid'))).toBe(false)
  })

  it('names the field when the YAML parses but the policy is invalid', () => {
    writeFileSync(join(home, 'policy.yaml'), 'rules:\n  - effect: maybe\n')
    expect(() => startForeman({ withTui: false })).toThrow(/failed to parse \(line 2\): rules\.0\.\w+: /)
  })

  it('reaches every agent entry point as a PolicyLoadError', () => {
    const path = join(home, 'policy.yaml')
    writeFileSync(path, 'rules: [\n')
    const { db, sqlite } = createInMemoryDb()
    try {
      expect(() =>
        createMediatorStack({ db, bus, approval: new DenyAllApprovalService(), policyPath: path }),
      ).toThrow(PolicyLoadError)
    } finally {
      sqlite.close()
    }
  })

  // #656 (M5) and #657 together: only a file broken at startup stops
  // anything; once running, a broken edit keeps the last good policy.
  it('once running, a broken edit keeps the last good policy and is reported once', async () => {
    const path = join(home, 'policy.yaml')
    const write = (text: string, bump: number): void => {
      writeFileSync(path, text)
      const t = new Date(Date.now() + bump * 1000)
      utimesSync(path, t, t)
    }
    write('rules:\n  - source: qa-bot\n    target: tool:list_files\n    effect: deny\n', 1)
    const errors: string[] = []
    const { db, sqlite } = createInMemoryDb()
    try {
      const { policy } = createMediatorStack({
        db,
        bus,
        approval: new DenyAllApprovalService(),
        policyPath: path,
        onPolicyError: (message) => errors.push(message),
      })
      const listFiles = () => policy.evaluate({ sourceAgent: 'qa-bot', targetTool: 'list_files', args: {} }).decision
      expect(listFiles()).toBe('deny')
      write('- this is: [broken\n', 2)
      await new Promise((r) => setTimeout(r, 300))
      expect(listFiles()).toBe('deny')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/last good policy stays in force/)
    } finally {
      sqlite.close()
    }
  })

  it('a missing policy.yaml loads nothing and stops nothing', () => {
    const { db, sqlite } = createInMemoryDb()
    try {
      expect(() =>
        createMediatorStack({ db, bus, approval: new DenyAllApprovalService(), policyPath: join(home, 'none.yaml') }),
      ).not.toThrow()
    } finally {
      sqlite.close()
    }
  })

  it('foreman wrap and policy show print it and exit 1, no stack', () => {
    appendFileSync(join(home, 'policy.yaml'), '- this is: [broken\n')
    const env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    for (const args of [['wrap', '--name', 'x', '--', 'true'], ['policy', 'show']]) {
      const out = spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
      expect(out.status).toBe(1)
      expect(out.stderr).toMatch(/error: .*policy\.yaml failed to parse \(line \d+\): /)
      expect(out.stderr).not.toMatch(/YAMLParseError|at .*\.js:\d+/)
    }
  })
})
