import { afterEach, describe, expect, it } from 'vitest'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { describeConditions } from '../../src/tui/pages/policy-page.js'
import { describeRule } from '../../src/tui/policy-rule-text.js'
import { DEFAULT_POLICY_YAML } from '../../src/cli/policy-template.js'
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
    expect(frame).toContain('Ask before reading files matching a pattern · any agent → tool:read_file')
    expect(frame).toContain('Allow reading files · any agent → tool:read_file')
    // The raw pattern is gone from the list…
    expect(frame).not.toContain('\\.env$')
    // …and still in the rule's detail view.
    await m.press('\r')
    expect(m.frame()).toContain('condition: path ~ /\\.env$/')
  })

  it('says what each default rule does in plain words', async () => {
    m = await mountApp(({ db, bus }) => {
      const policy = new PolicyEngine(db, bus)
      policy.loadYamlText(DEFAULT_POLICY_YAML)
      return { policy }
    })
    await m.press('p')
    const frame = m.frame()
    expect(frame).toContain('Ask before reading secret files (.env, *.key, SSH keys, .npmrc, ~/.ssh, AWS credentials)')
    expect(frame).toContain('Ask before writing secret files (.env, *.key, SSH keys, ~/.ssh, AWS credentials)')
    expect(frame).toContain('Ask before running risky commands (rm -rf, chmod 777, fork bomb, pipe to shell, curl')
    expect(frame).toContain('Allow listing folders')
    expect(frame).not.toMatch(/path ~|\(\^\|\/\)/)
  })

  it('shows hidden characters in a rule\'s agent and target as stand-ins', async () => {
    // A remembered rule's target is built from an agent's tool name, so it
    // can carry escape sequences; they must not reach the terminal (#656).
    m = await mountApp(({ db, bus }) => {
      const policy = new PolicyEngine(db, bus)
      policy.loadYamlText(
        ['rules:', '  - source: "*"', '    target: "tool:x\\e[2K\\rsafe_tool"', '    effect: deny', ''].join('\n'),
      )
      return { policy }
    })
    await m.press('p')
    const frame = m.frame()
    expect(frame).toContain('tool:x␛[2K␍safe_tool')
    expect(frame).not.toContain('\u001b[2K')
    expect(frame).not.toContain('\r')
  })

  it('describes rules Foreman writes itself, and unknown ones generically', () => {
    const rule = (effect: 'allow' | 'deny' | 'ask', target: string, conditions: object | null) =>
      describeRule({ effect, target, conditions: conditions ? JSON.stringify(conditions) : null })
    // "Always deny" on one file (remember-scope.ts).
    expect(rule('deny', 'tool:read_file', { pathMatch: ['^/p/\\.env$'] })).toBe('Block reading the file "/p/.env"')
    // A Telegram block button (predicate-hint.ts).
    expect(rule('deny', 'tool:read_file', { pathMatch: ['/id_(rsa|ed25519|ecdsa|dsa)(\\.pub)?$'] })).toBe(
      'Block reading secret files (SSH keys)',
    )
    expect(rule('deny', 'tool:read_file', { pathMatch: ['/notes\\.txt$'] })).toBe('Block reading files named "notes.txt"')
    expect(rule('allow', 'tool:shell_exec', { commandMatch: ['npm test'] })).toBe(
      'Allow running commands containing "npm test"',
    )
    expect(rule('deny', '*', { argContains: 'pastebin.com' })).toBe('Block calling any tool when the call mentions "pastebin.com"')
    expect(rule('deny', 'tool:*', { toolPattern: '^read_' })).toBe('Block calling tools starting with "read_"')
    expect(rule('ask', 'tool:read_file', { toolPattern: '(a|b)' })).toBe(
      'Ask before reading files for tools whose name matches a pattern',
    )
    expect(rule('ask', 'claude-code:write', null)).toBe('Ask before handing work to claude-code')
    expect(rule('deny', 'secret:github-pat', null)).toBe('Block using the secret "github-pat"')
    expect(rule('ask', 'tool:deploy', { pathMatch: ['^src/.*'], rateLimits: { messagesPerMinute: 30 } })).toBe(
      'Ask before calling "deploy" on files matching a pattern over 30 calls a minute',
    )
    expect(rule('ask', 'tool:read_file', { pathMatch: ['a.b', 'c'], pathNotMatch: 'tmp' })).toBe(
      'Ask before reading files matching one of 2 patterns except files matching a pattern',
    )
    // Agent-supplied names can't reach the terminal raw (#656).
    expect(rule('deny', 'tool:x\u001b[2K', null)).toBe('Block calling "x␛[2K"')
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
