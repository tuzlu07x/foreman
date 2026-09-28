import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateOrg, parseOrgText } from '../../src/core/org/org.js'
import { agentAddCommand } from '../../src/core/registry-catalog.js'
import { stubInstallers } from '../support/stub-installers.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 M7 — the README quick start `foreman agent add claude-code`
// failed with "scripted form requires both <name> and --type", and
// org show / validate / doctor suggested the same failing command.
describe('foreman agent add <registry-id>', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-agent-add-id-'))
    env = {
      HOME: join(dir, 'home'),
      FOREMAN_HOME: join(dir, 'fh'),
      TMPDIR: dir,
      PATH: stubInstallers(dir).path,
      NO_COLOR: '1',
      FOREMAN_NO_UPDATE_CHECK: '1',
    }
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('uses the name as the type when it is a registry id', () => {
    const out = run('agent', 'add', 'claude-code', '--skip-config')
    expect(out.stderr).not.toContain('requires both')
    expect(out.status).toBe(0)
    const shown = JSON.parse(run('agent', 'show', 'claude-code', '--json').stdout) as { metadata: { registryId: string } }
    expect(shown.metadata.registryId).toBe('claude-code')
  })

  it('asks for --type when the name is not a registry id', () => {
    const out = run('agent', 'add', 'my-bot')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('foreman agent add my-bot --type <registry-id>')
  })

  it('org validate suggests a command that works', () => {
    writeFileSync(
      join(dir, 'fh', 'org.yaml'),
      'version: 1\ncompany: Acme\nroles:\n  cto:\n    title: CTO\n    agent: claude-code\n    reports_to: human\n  ops:\n    title: Ops\n    agent: my-bot\n    reports_to: human\n',
    )
    const out = run('org', 'validate')
    const text = out.stdout + out.stderr
    expect(text).toContain('foreman agent add claude-code)')
    expect(text).toContain('foreman agent add my-bot --type <registry-id>')
  })
})

describe('agentAddCommand', () => {
  it('needs no --type for a registry id, and asks for one otherwise', () => {
    expect(agentAddCommand('hermes')).toBe('foreman agent add hermes')
    expect(agentAddCommand('boss')).toBe('foreman agent add boss --type <registry-id>')
  })

  it('is what org validation suggests', () => {
    const doc = parseOrgText('version: 1\ncompany: Acme\nroles:\n  lead:\n    title: Lead\n    agent: codex\n    reports_to: human\n')
    const issue = validateOrg(doc, new Set()).find((i) => i.message.includes('not registered'))
    expect(issue?.message).toContain('(foreman agent add codex)')
  })
})
