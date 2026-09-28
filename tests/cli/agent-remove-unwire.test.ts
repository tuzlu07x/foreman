import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stubInstallers } from '../support/stub-installers.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA M8 — `foreman agent remove` left the `foreman` MCP entry in
// ~/.claude.json and Foreman's PreToolUse hook in ~/.claude/settings.json.
describe('foreman agent remove takes Foreman out of the agent config', () => {
  let dir: string
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-agent-unwire-'))
    home = join(dir, 'home')
    env = {
      HOME: home,
      FOREMAN_HOME: join(dir, 'fh'),
      TMPDIR: dir,
      PATH: stubInstallers(dir).path,
      NO_COLOR: '1',
      FOREMAN_NO_UPDATE_CHECK: '1',
    }
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ numStartups: 7, mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } } }, null, 2),
    )
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify(
        { env: { KEEP: '1' }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check' }] }] } },
        null,
        2,
      ),
    )
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('removes mcpServers.foreman and the hook, keeping everything else', () => {
    const add = run('agent', 'add', 'claude-code')
    expect(add.status, add.stderr).toBe(0)
    const hook = run('agent', 'hook', 'install', 'claude-code')
    expect(hook.status, hook.stderr).toBe(0)
    const wired = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')) as { mcpServers: Record<string, unknown> }
    expect(wired.mcpServers.foreman).toBeDefined()
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toContain('foreman.pre-tool-use')

    const out = run('agent', 'remove', 'claude-code', '--yes')

    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('agent claude-code removed')
    expect(out.stdout).toContain(`removed mcpServers.foreman from ${join(home, '.claude.json')}`)
    expect(out.stdout).toContain(`removed Foreman's PreToolUse hook from ${join(home, '.claude', 'settings.json')}`)
    expect(`${out.stdout}${out.stderr}`).not.toContain('fat_')

    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')) as Record<string, unknown>
    expect(claude).toEqual({ numStartups: 7, mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } } })
    const settingsText = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')
    expect(settingsText).not.toContain('foreman.pre-tool-use')
    const settings = JSON.parse(settingsText) as { env: unknown; hooks: { PreToolUse: unknown[] } }
    expect(settings.env).toEqual({ KEEP: '1' })
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check' }] }])
  })

  it('still removes the agent when its config does not parse, and says so', () => {
    expect(run('agent', 'add', 'claude-code').status).toBe(0)
    writeFileSync(join(home, '.claude.json'), '{ not json')

    const out = run('agent', 'remove', 'claude-code', '--yes')

    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('agent claude-code removed')
    expect(out.stdout).toContain("doesn't parse as JSON; nothing removed from it")
    expect(run('agent', 'show', 'claude-code').status).not.toBe(0)
  })
})
