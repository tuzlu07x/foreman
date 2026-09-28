import { afterEach, describe, expect, it } from 'vitest'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { describeConditions } from '../../src/tui/pages/policy-page.js'
import { mountApp, type MountedApp } from '../support/tui-app.js'

// QA #657 L33 — the Policy page listed "read_file ASK" and "read_file
// ALLOW" without their conditions, so they looked contradictory.
describe('Policy page conditions', () => {
  let m: MountedApp
  afterEach(() => m.unmount())

  it('shows each rule\'s conditions on its row', async () => {
    m = await mountApp(({ db, bus }) => {
      const policy = new PolicyEngine(db, bus)
      policy.loadYamlText(
        [
          'rules:',
          '  - source: "*"',
          '    target: tool:read_file',
          '    effect: ask',
          '    conditions:',
          '      pathMatch: ["\\\\.env$"]',
          '  - source: "*"',
          '    target: tool:read_file',
          '    effect: allow',
          '',
        ].join('\n'),
      )
      return { policy }
    })
    await m.press('p')
    const frame = m.frame()
    expect(frame).toMatch(/tool:read_file ASK if path ~ \/\\\.env\$\//)
    expect(frame).toMatch(/tool:read_file ALLOW(?! if)/)
  })

  it('describes every kind of condition', () => {
    expect(describeConditions(null)).toBe('none')
    expect(
      describeConditions(
        JSON.stringify({
          pathMatch: ['a', 'b'],
          pathNotMatch: 'tmp',
          commandMatch: ['rm -rf'],
          toolPattern: '^read_',
          argContains: 'pastebin.com',
          rateLimits: { messagesPerMinute: 30, tokensPerHour: 1000 },
        }),
      ),
    ).toBe(
      'path ~ /a/ or /b/, path !~ /tmp/, command has "rm -rf", tool ~ /^read_/, args contain "pastebin.com", over 30 calls/min, over 1000 tokens/h',
    )
    // A remembered rule's pattern comes from an agent's call: hidden
    // characters show as stand-ins (#656), never reach the terminal.
    expect(describeConditions(JSON.stringify({ pathMatch: ['x\u001b[2K\rdocs'] }))).toBe('path ~ /x␛[2K␍docs/')
  })
})
