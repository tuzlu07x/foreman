import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================================
// Unit tests for the shared TTY guard helpers
// =============================================================================
//
// Behavioural surfaces are covered by the per-command tests
// (secrets-remove-non-tty, policy-non-tty, agent-non-tty, identity-non-tty);
// these tests pin the helper's contract so the next destructive command we add
// can rely on it without re-deriving the rules.

// node:readline is mocked at module level so we can stub the y/N prompt
// without redefining its read-only `createInterface` binding at runtime.
let nextAnswer = ''
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(nextAnswer),
    close: () => {},
  }),
}))

const { requireConfirm, requireTty } = await import(
  '../../src/cli/require-confirm.js'
)

interface MockedStream {
  isTTY?: boolean
}

describe('requireConfirm', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  const origStdinIsTTY = process.stdin.isTTY

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    ;(process.stdin as MockedStream).isTTY = origStdinIsTTY
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('returns true immediately when yes is true', async () => {
    ;(process.stdin as MockedStream).isTTY = false
    const result = await requireConfirm({
      yes: true,
      question: 'Remove foo?',
      noun: 'remove "foo"',
    })
    expect(result).toBe(true)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('exits 1 with a standardised refusal in non-TTY without --yes', async () => {
    ;(process.stdin as MockedStream).isTTY = false
    await requireConfirm({
      question: 'Remove foo?',
      noun: 'remove "foo"',
    })
    expect(exitSpy).toHaveBeenCalledWith(1)
    const msg = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(msg).toContain('refusing to remove "foo" in a non-interactive context')
    expect(msg).toContain('Pass --yes to confirm.')
  })

  it('prompts in TTY and resolves true on "y"', async () => {
    ;(process.stdin as MockedStream).isTTY = true
    nextAnswer = 'y'
    const result = await requireConfirm({
      question: 'Remove foo?',
      noun: 'remove "foo"',
    })
    expect(result).toBe(true)
  })

  it.each(['n', '', 'no-thanks', 'whatever'])(
    'prompts in TTY and resolves false on %j',
    async (answer) => {
      ;(process.stdin as MockedStream).isTTY = true
      nextAnswer = answer
      const result = await requireConfirm({
        question: 'Remove foo?',
        noun: 'remove "foo"',
      })
      expect(result).toBe(false)
    },
  )

  it.each(['yes', 'YES', 'Y'])(
    'accepts %j as a positive answer',
    async (answer) => {
      ;(process.stdin as MockedStream).isTTY = true
      nextAnswer = answer
      const result = await requireConfirm({
        question: 'Remove foo?',
        noun: 'remove "foo"',
      })
      expect(result).toBe(true)
    },
  )
})

describe('requireTty', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  const origStdinIsTTY = process.stdin.isTTY
  const origStdoutIsTTY = process.stdout.isTTY

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    ;(process.stdin as MockedStream).isTTY = origStdinIsTTY
    ;(process.stdout as MockedStream).isTTY = origStdoutIsTTY
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('returns silently when both stdin and stdout are TTY', () => {
    ;(process.stdin as MockedStream).isTTY = true
    ;(process.stdout as MockedStream).isTTY = true
    requireTty({ command: 'policy edit', fallbackPath: '/etc/policy.yaml' })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('exits 1 with a friendly message when stdin is not a TTY', () => {
    ;(process.stdin as MockedStream).isTTY = false
    ;(process.stdout as MockedStream).isTTY = true
    requireTty({ command: 'policy edit', fallbackPath: '/etc/policy.yaml' })
    expect(exitSpy).toHaveBeenCalledWith(1)
    const msg = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(msg).toContain("'policy edit' requires an interactive terminal")
    expect(msg).toContain('/etc/policy.yaml')
  })

  it('exits 1 when stdout is not a TTY (e.g. piped)', () => {
    ;(process.stdin as MockedStream).isTTY = true
    ;(process.stdout as MockedStream).isTTY = false
    requireTty({ command: 'identity edit', fallbackPath: '/etc/SOUL.md' })
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('omits the fallback hint when no path is provided', () => {
    ;(process.stdin as MockedStream).isTTY = false
    ;(process.stdout as MockedStream).isTTY = true
    requireTty({ command: 'wizard' })
    expect(exitSpy).toHaveBeenCalledWith(1)
    const msg = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(msg).toContain("'wizard' requires an interactive terminal")
    expect(msg).not.toMatch(/^\s+undefined/m)
  })
})
