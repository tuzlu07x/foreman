import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

describe('foreman notify approval-bot (#610)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  const notifyYaml = () => readFileSync(join(home, 'notify.yaml'), 'utf-8')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-approval-bot-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('needs Telegram set up first', () => {
    const out = run('notify', 'approval-bot', '--no-verify')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('set up Telegram first')
  })

  it('refuses a missing secret and a token shared with the chat bot, then turns on and off', () => {
    writeFileSync(
      join(home, 'notify.yaml'),
      'channels:\n  telegram:\n    enabled: true\n    bot_token_ref: telegram-bot-token\n    chat_id: "424242"\n',
    )
    expect(run('secrets', 'add', 'telegram-bot-token', '--value', '111:chat-bot').status).toBe(0)

    const missing = run('notify', 'approval-bot', '--no-verify')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('foreman secrets add telegram-approval-bot-token')

    expect(run('secrets', 'add', 'telegram-approval-bot-token', '--value', '111:chat-bot').status).toBe(0)
    const shared = run('notify', 'approval-bot', '--no-verify')
    expect(shared.status).toBe(1)
    expect(shared.stderr).toContain('different bot')

    expect(run('secrets', 'rotate', 'telegram-approval-bot-token', '--value', '222:approval-bot').status).toBe(0)
    const on = run('notify', 'approval-bot', '--no-verify')
    expect(on.status).toBe(0)
    expect(notifyYaml()).toContain('approval_bot_token_ref: telegram-approval-bot-token')
    expect(notifyYaml()).not.toContain('222:approval-bot')

    expect(run('notify', 'approval-bot', '--off').status).toBe(0)
    expect(notifyYaml()).not.toContain('approval_bot_token_ref')
  })
})
