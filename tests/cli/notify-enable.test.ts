import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 M10 — `secrets add telegram-bot-token`, `notify enable telegram`,
// `notify test telegram` → "telegram needs bot_token_ref and chat_id".
describe('foreman notify enable', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (args: string[], input?: string) =>
    spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8', ...(input !== undefined ? { input } : {}) })
  const channels = () =>
    (parse(readFileSync(join(home, 'notify.yaml'), 'utf-8')) as { channels: Record<string, Record<string, unknown>> }).channels

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-notify-enable-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run(['init']).status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('points telegram at its token and the stored chat id', () => {
    expect(run(['secrets', 'add', 'telegram-bot-token'], '123:fake-token\n').status).toBe(0)
    expect(run(['secrets', 'add', 'telegram-chat-id'], '4242\n').status).toBe(0)
    const out = run(['notify', 'enable', 'telegram'])
    expect(out.status).toBe(0)
    expect(channels().telegram).toMatchObject({ enabled: true, bot_token_ref: 'telegram-bot-token', chat_id: '4242' })
    expect(out.stdout).toContain('foreman notify test telegram')
  })

  it('takes --chat-id and says which secret is still missing', () => {
    const out = run(['notify', 'enable', 'telegram', '--chat-id', '-100555'])
    expect(channels().telegram).toMatchObject({ bot_token_ref: 'telegram-bot-token', chat_id: '-100555' })
    expect(out.stdout).toContain("telegram can't send yet")
    expect(out.stdout).toContain('foreman secrets add telegram-bot-token')
  })

  it('sets the slack, discord and webhook refs', () => {
    run(['notify', 'enable', 'slack'])
    run(['notify', 'enable', 'discord', '--channel', '112233'])
    expect(run(['secrets', 'add', 'webhook-url'], 'https://example.test/hook\n').status).toBe(0)
    run(['notify', 'enable', 'webhook'])
    const ch = channels()
    expect(ch.slack).toMatchObject({ enabled: true, webhook_url_ref: 'slack-webhook-url' })
    expect(ch.discord).toMatchObject({ enabled: true, bot_token_ref: 'discord-bot-token', channel: '112233' })
    expect(ch.webhook).toMatchObject({ enabled: true, webhook_url_ref: 'webhook-url' })
  })
})
