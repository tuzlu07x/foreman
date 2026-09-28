import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

// #656 (M5): policy.yaml edits reach a running process, a broken edit keeps
// the last good policy, and rule ids don't churn.

const ALLOW = `rules:
  - source: qa-bot
    target: tool:list_files
    effect: allow
  - source: "*"
    target: tool:read_file
    effect: ask
`
const DENY = ALLOW.replace('target: tool:list_files\n    effect: allow', 'target: tool:list_files\n    effect: deny')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('policy.yaml hot reload and stable rule ids (#656)', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let path: string
  const listFiles = (engine: PolicyEngine) =>
    engine.evaluate({ sourceAgent: 'qa-bot', targetTool: 'list_files', args: { path: '.' } })
  /** Write and push the mtime forward, so the change is seen even on
   *  file systems with coarse timestamps. */
  const write = (text: string, bump: number) => {
    writeFileSync(path, text)
    const t = new Date(Date.now() + bump * 1000)
    utimesSync(path, t, t)
  }

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-policy-reload-'))
    path = join(dir, 'policy.yaml')
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a watched file is re-read when it changes, without a restart', async () => {
    write(ALLOW, 1)
    const engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    engine.watchFile(path)
    expect(listFiles(engine).decision).toBe('allow')
    write(DENY, 2)
    await sleep(300)
    expect(listFiles(engine).decision).toBe('deny')
  })

  it('a broken edit keeps the last good policy and is reported once per version', async () => {
    write(ALLOW, 1)
    const onError = vi.fn()
    const engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    engine.watchFile(path, onError)
    write('- this is: [broken\n', 2)
    await sleep(300)
    expect(listFiles(engine).decision).toBe('allow')
    await sleep(300)
    expect(listFiles(engine).decision).toBe('allow')
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toMatch(/last good policy stays in force/)
    write(DENY, 3)
    await sleep(300)
    expect(listFiles(engine).decision).toBe('deny')
    write('rules: [{ source: x }]\n', 4)
    await sleep(300)
    expect(listFiles(engine).decision).toBe('deny')
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('never throws, even when the file is broken from the start', () => {
    write('- nope: [\n', 1)
    const onError = vi.fn()
    const engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    expect(() => engine.watchFile(path, onError)).not.toThrow()
    expect(onError).toHaveBeenCalledOnce()
    // No rules: the engine's default, which asks.
    expect(listFiles(engine).decision).toBe('ask')
  })

  it('reloading keeps the id of every unchanged rule, across engines (processes)', () => {
    const first = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    first.loadYamlText(ALLOW)
    const before = first.list().map((r) => [r.id, r.target, r.effect])
    const second = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    second.loadYamlText(ALLOW)
    second.loadYamlText(ALLOW)
    expect(second.list().map((r) => [r.id, r.target, r.effect])).toEqual(before)
    // Changing one rule replaces that rule only.
    second.loadYamlText(DENY)
    const after = second.list()
    const readFile = after.find((r) => r.target === 'tool:read_file')!
    expect(readFile.id).toBe(before.find(([, target]) => target === 'tool:read_file')![0])
    const listRule = after.find((r) => r.target === 'tool:list_files')!
    expect(listRule.effect).toBe('deny')
    expect(listRule.id).not.toBe(before[0]![0])
    expect(after).toHaveLength(2)
  })

  it('keeps remembered rules and duplicate yaml rules intact', () => {
    const engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    const remembered = engine.remember({ sourceAgent: 'qa-bot', target: 'tool:shell_exec', effect: 'deny' })
    const twice = `${ALLOW}  - source: "*"\n    target: tool:read_file\n    effect: ask\n`
    engine.loadYamlText(twice)
    engine.loadYamlText(twice)
    expect(engine.list().filter((r) => r.target === 'tool:read_file')).toHaveLength(2)
    engine.loadYamlText(ALLOW)
    expect(engine.list().filter((r) => r.target === 'tool:read_file')).toHaveLength(1)
    expect(engine.list().some((r) => r.id === remembered)).toBe(true)
  })
})
