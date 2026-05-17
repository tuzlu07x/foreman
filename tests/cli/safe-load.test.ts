import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { safeLoadConfig } from '../../src/cli/safe-load.js'
import { loadLlmConfig } from '../../src/core/llm/config.js'
import { loadNotifyConfig } from '../../src/core/notification/notify-config.js'

// =============================================================================
// Regression for #262 — every CLI command that reads user-editable YAML must
// fail with a friendly message, not a raw Node stacktrace. safeLoadConfig is
// the shared helper that wraps the loader; this file pins both real loaders
// (llm + notify) AND the synthetic Zod error path.
// =============================================================================

let tmp: string
let exitSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>
let exits: number[]
let errs: string[]

class TestExit extends Error {
  code: number
  constructor(code: number) {
    super(`process.exit(${code})`)
    this.code = code
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'foreman-safeload-'))
  exits = []
  errs = []
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code: number) => {
      exits.push(code)
      throw new TestExit(code) // halt the function under test like real exit
    }) as never)
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errs.push(args.join(' '))
  })
})

afterEach(() => {
  exitSpy.mockRestore()
  errSpy.mockRestore()
  rmSync(tmp, { recursive: true, force: true })
})

describe('safeLoadConfig — yaml parse error', () => {
  it('prints a friendly error + exits 1 on malformed llm.yaml', () => {
    const path = join(tmp, 'llm.yaml')
    writeFileSync(path, 'broken: { yaml')
    expect(() =>
      safeLoadConfig(path, loadLlmConfig, { label: 'llm.yaml' }),
    ).toThrow(TestExit)
    expect(exits).toEqual([1])
    expect(errs.join('\n')).toContain('llm.yaml')
    expect(errs.join('\n')).toContain('failed to parse')
    expect(errs.join('\n')).toContain('Open ')
  })

  it('prints a friendly error + exits 1 on malformed notify.yaml', () => {
    const path = join(tmp, 'notify.yaml')
    writeFileSync(path, 'broken: { yaml')
    expect(() =>
      safeLoadConfig(path, loadNotifyConfig, { label: 'notify.yaml' }),
    ).toThrow(TestExit)
    expect(exits).toEqual([1])
    expect(errs.join('\n')).toContain('notify.yaml')
    expect(errs.join('\n')).toContain('failed to parse')
  })
})

describe('safeLoadConfig — zod schema error', () => {
  it('lists per-field issues and exits 1 when llm.yaml has wrong types', () => {
    const path = join(tmp, 'llm.yaml')
    writeFileSync(path, 'enabled: "yes"\n')
    expect(() =>
      safeLoadConfig(path, loadLlmConfig, { label: 'llm.yaml' }),
    ).toThrow(TestExit)
    expect(exits).toEqual([1])
    const out = errs.join('\n')
    expect(out).toContain('missing or invalid')
    expect(out).toContain('enabled')
    expect(out).toContain('Expected boolean')
  })

  it('truncates long issue lists to 5 with "+ N more issues"', () => {
    const customSchema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    })
    const path = join(tmp, 'x.yaml')
    writeFileSync(path, '{}\n')
    expect(() =>
      safeLoadConfig(path, (_p) => customSchema.parse({})),
    ).toThrow(TestExit)
    const out = errs.join('\n')
    expect(out).toMatch(/\+ \d+ more issues/)
  })
})

describe('safeLoadConfig — happy path', () => {
  it('returns the parsed config unchanged when the file is valid', () => {
    const path = join(tmp, 'llm.yaml')
    writeFileSync(path, 'enabled: true\nprovider: anthropic\nmodel: m\n')
    const config = safeLoadConfig(path, loadLlmConfig)
    expect(config.enabled).toBe(true)
    expect(config.provider).toBe('anthropic')
  })

  it('re-throws unknown errors (not yaml/zod) so callers can handle them', () => {
    const path = join(tmp, 'x.yaml')
    writeFileSync(path, '{}\n')
    const customLoader = (_p: string): unknown => {
      throw new Error('totally unexpected')
    }
    expect(() => safeLoadConfig(path, customLoader)).toThrow(/totally unexpected/)
    // exit was NOT called — error bubbles up.
    expect(exits).toEqual([])
  })
})
