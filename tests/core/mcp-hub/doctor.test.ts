import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMcpHub, checkNotifyChannels, checkOrg } from '../../../src/core/doctor.js'
import { findOrgTemplate } from '../../../src/core/org/templates.js'
import { closeDb } from '../../../src/db/client.js'

describe('doctor: mcp_hub check', () => {
  let home: string
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FOREMAN_HOME
    home = mkdtempSync(join(tmpdir(), 'foreman-doctor-hub-'))
    process.env.FOREMAN_HOME = home
  })
  afterEach(() => {
    closeDb()
    if (prev === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })

  it('is ok when the hub is not configured', () => {
    expect(checkMcpHub().status).toBe('ok')
  })

  it('fails on an invalid mcp.yaml', () => {
    writeFileSync(join(home, 'mcp.yaml'), 'servers:\n  Bad_Name:\n    command: x\n')
    expect(checkMcpHub().status).toBe('fail')
  })

  it('warns about missing secrets for enabled servers', () => {
    writeFileSync(
      join(home, 'mcp.yaml'),
      'servers:\n  gh:\n    url: https://api.githubcopilot.com/mcp/\n    headers:\n      Authorization: "Bearer ${secret:github-pat}"\n',
    )
    const result = checkMcpHub()
    expect(result.status).toBe('warn')
    expect(result.message).toContain('gh: github-pat')
  })
})

describe('doctor: org check', () => {
  let home: string
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FOREMAN_HOME
    home = mkdtempSync(join(tmpdir(), 'foreman-doctor-org-'))
    process.env.FOREMAN_HOME = home
  })
  afterEach(() => {
    closeDb()
    if (prev === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })

  it('warns about roles whose agents are not registered', () => {
    writeFileSync(join(home, 'org.yaml'), findOrgTemplate('solo')!.render('Me'))
    const result = checkOrg()
    expect(result.status).toBe('warn')
    expect(result.message).toContain('hermes')
  })

  it('fails on a broken org chart', () => {
    writeFileSync(join(home, 'org.yaml'), 'version: 1\ncompany: X\nroles: {}\n')
    expect(checkOrg().status).toBe('fail')
  })
})

describe('doctor: notify_channels check', () => {
  let home: string
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FOREMAN_HOME
    home = mkdtempSync(join(tmpdir(), 'foreman-doctor-notify-'))
    process.env.FOREMAN_HOME = home
  })
  afterEach(() => {
    closeDb()
    if (prev === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })

  it('reports a Slack channel enabled without a destination (the wizard gap)', () => {
    writeFileSync(
      join(home, 'notify.yaml'),
      'channels:\n  slack:\n    enabled: true\n    bot_token_ref: slack-bot-token\nrouting:\n  critical:\n    channels: [slack]\n',
    )
    const result = checkNotifyChannels()
    expect(result.status).toBe('warn')
    expect(result.message).toMatch(/slack: slack needs webhook_url_ref/)
  })

  it('reports an enabled channel that no level routes to', () => {
    writeFileSync(join(home, 'notify.yaml'), 'channels:\n  system:\n    enabled: true\nrouting:\n  critical:\n    channels: []\n  warning:\n    channels: []\n  summary:\n    channels: []\n  budget_alert:\n    channels: []\n  risk_deny:\n    channels: []\n  session_lifecycle:\n    channels: []\n')
    expect(checkNotifyChannels().message).toContain('system: enabled but no level routes to it')
  })
})
