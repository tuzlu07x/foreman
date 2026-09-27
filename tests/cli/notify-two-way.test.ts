import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// #615 — `foreman notify slack-interactive` / `discord-interactive`, the
// doctor summary, and the reserved source ids.

describe('two-way Slack and Discord setup (#615)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })
  const notifyYaml = () => readFileSync(join(home, 'notify.yaml'), 'utf-8')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-two-way-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('slack-interactive checks the setup, stores the users, and turns off again', () => {
    expect(run('notify', 'slack-interactive', '--user', 'U0OWNER1', '--no-verify').stderr).toContain('set up Slack first')
    writeFileSync(
      join(home, 'notify.yaml'),
      'channels:\n  slack:\n    enabled: true\n    bot_token_ref: slack-bot-token\n    channel: alerts\nrouting:\n  critical:\n    channels: [slack]\n',
    )
    expect(run('notify', 'slack-interactive', '--no-verify').stderr).toContain('--user')
    expect(run('notify', 'slack-interactive', '--user', 'not an id', '--no-verify').stderr).toContain('not a user id')
    const missing = run('notify', 'slack-interactive', '--user', 'U0OWNER1', '--no-verify')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('foreman secrets add slack-app-token')

    expect(run('secrets', 'add', 'slack-bot-token', '--value', 'xoxb-test').status).toBe(0)
    expect(run('secrets', 'add', 'slack-app-token', '--value', 'xapp-1-test').status).toBe(0)
    const on = run('notify', 'slack-interactive', '--user', 'U0OWNER1,U0OTHER2', '--no-verify')
    expect(on.status).toBe(0)
    expect(on.stdout).toContain('Slash Commands')
    expect(notifyYaml()).toContain('app_token_ref: slack-app-token')
    expect(notifyYaml()).toMatch(/allowed_user_ids:\n\s+- U0OWNER1\n\s+- U0OTHER2/)
    expect(notifyYaml()).not.toContain('xapp-1-test')

    const doctor = run('doctor', '--json')
    expect(doctor.stdout).toContain('two-way: slack (2 user(s))')

    expect(run('notify', 'slack-interactive', '--off').status).toBe(0)
    expect(notifyYaml()).not.toContain('app_token_ref')
    expect(notifyYaml()).not.toContain('allowed_user_ids')
  })

  it('discord-interactive needs a bot, not a webhook', () => {
    writeFileSync(
      join(home, 'notify.yaml'),
      'channels:\n  discord:\n    enabled: true\n    webhook_url_ref: discord-webhook-url\n',
    )
    expect(run('notify', 'discord-interactive', '--user', '111111111111111111', '--no-verify').stderr).toContain(
      'needs a bot',
    )
    writeFileSync(
      join(home, 'notify.yaml'),
      'channels:\n  discord:\n    enabled: true\n    bot_token_ref: discord-bot-token\n    channel: "777777777777777777"\n',
    )
    const on = run('notify', 'discord-interactive', '--user', '111111111111111111', '--no-verify')
    expect(on.status).toBe(0)
    expect(notifyYaml()).toContain('interactive: true')
    expect(run('notify', 'discord-interactive', '--off').status).toBe(0)
    expect(notifyYaml()).not.toContain('interactive: true')
  })

  it('an agent cannot claim a human source id', () => {
    const out = run('mcp-stdio', '--source', 'tui')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain("'tui' is reserved")
  })
})
