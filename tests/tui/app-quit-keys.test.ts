import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import { CTRL_C, mountApp, tick, type MountedApp } from '../support/tui-app.js'

// QA #657 L6 — Ctrl-C did nothing while an approval was on screen (and on
// most pages), `q` quit without a question on every page, and the help
// said "q / Ctrl-C quit (with confirm)". Now both keys quit at once when
// nothing is waiting, and ask first while approvals wait.

const approval = (requestId: string): ApprovalRequest => ({
  requestId,
  sourceAgent: 'codex',
  targetTool: 'shell_exec',
  args: { command: 'ls' },
  riskScore: 70,
  riskReasons: ['shell'],
  riskFactors: [],
  riskBucket: 'high',
  llmVerification: null,
  securityReport: null,
  deadlineMs: Date.now() + 60_000,
})

describe('q and Ctrl-C', () => {
  let m: MountedApp
  afterEach(() => m.unmount())

  // After exit() Ink stops reading keys: Esc (home) then `l` (Logs) no
  // longer switch pages.
  const exited = async (): Promise<boolean> => {
    await m.press('\u001B')
    await m.press('l')
    return !m.frame().includes('Filter:')
  }

  it('the exit check sees a live app', async () => {
    m = await mountApp()
    await m.press('p')
    expect(await exited()).toBe(false)
  })

  it.each([
    ['q', 'q'],
    ['Ctrl-C', CTRL_C],
  ])('%s quits at once on a page when nothing is waiting', async (_name, key) => {
    m = await mountApp()
    await m.press('p')
    await m.press(key)
    expect(m.frame()).not.toContain('Quit Foreman?')
    expect(await exited()).toBe(true)
  })

  it.each([
    ['q', 'q'],
    ['Ctrl-C', CTRL_C],
  ])('%s asks first while an approval waits, and n keeps Foreman running', async (_name, key) => {
    m = await mountApp()
    m.bus.emit('approval:requested', approval(`r-${_name}`))
    await m.press('')
    await m.press(key)
    expect(m.frame()).toContain('Quit Foreman? Agents stop being guarded. Waiting calls will be denied.')
    expect(m.frame()).toContain('y quit')
    await m.press('n')
    expect(m.frame()).not.toContain('Quit Foreman?')
    expect(m.frame()).toContain('shell_exec')
  })

  // With #656's second key: `a` on a high-risk call asks "Allow this …?"
  // (y/n). `q` then used to put the quit question beside it, and `y`
  // quit although the modal said it would allow.
  it('q while an allow waits for its y leaves one question on screen: quit', async () => {
    const until = async (done: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3_000
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out; frame:\n${m.frame()}`)
        await tick(10)
      }
    }
    m = await mountApp()
    const resolved: string[] = []
    m.bus.on('approval:resolved', (e) => resolved.push(e.decision))
    m.bus.emit('approval:requested', approval('r-second-key'))
    await until(() => m.frame().includes('llow once'))
    // Past the moment the approval appears (production swallows keys
    // there for 600 ms; this app has no settle time).
    await tick(300)
    await m.press('a')
    await until(() => m.frame().includes('Allow this HIGH-risk call'))
    await m.press('q')
    await until(() => m.frame().includes('Quit Foreman?'))
    expect(m.frame()).not.toContain('Allow this HIGH-risk call')
    await m.press('n')
    await until(() => !m.frame().includes('Quit Foreman?'))
    // Back at the call: nothing decided, and no allow waiting for `y`.
    await m.press('y')
    expect(resolved).toEqual([])
    expect(m.frame()).toContain('shell_exec')
    expect(m.frame()).not.toContain('Allow this HIGH-risk call')
  })

  it('q typed into the Logs search is text, not quit', async () => {
    m = await mountApp()
    await m.press('l')
    await m.press('/')
    await m.press('q')
    expect(m.frame()).toContain('› q')
  })

  it('the help says what the keys do', async () => {
    m = await mountApp()
    await m.press('?')
    expect(m.frame()).toContain('quit (asks first)')
    expect(m.frame()).not.toContain('with confirm')
  })
})
