import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FOREMAN_SOUL } from '../../src/cli/identity-template.js'
import { buildProgram } from '../../src/cli/program.js'
import { rememberSetupSkipped } from '../../src/cli/start.js'
import { checkUpdate } from '../../src/core/doctor.js'
import { loadSetupState } from '../../src/tui/setup-state.js'
import { resolveDirs, type Platform } from '../../src/utils/config.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 — --help text that disagreed with the code or leaked internal
// notes: issue numbers and Turkish ("Faz"), `init` naming ~/.foreman/
// where the default is the XDG layout, `start --skip-setup` claiming to
// remember a choice it never saved, `notify summary --now` claiming every
// enabled channel, and doctor naming the wrong Homebrew formula.

function helpStrings(cmd: Command, path: string[] = []): Array<{ where: string; text: string }> {
  const here = [...path, cmd.name()].join(' ')
  const out = [{ where: here, text: cmd.description() }]
  for (const opt of cmd.options) out.push({ where: `${here} ${opt.flags}`, text: opt.description })
  for (const sub of cmd.commands) out.push(...helpStrings(sub, [...path, cmd.name()]))
  return out
}

// Render the full --help output (usage, arguments, options, subcommands
// and any addHelpText blocks) for `cmd` and every command below it.
function renderedHelp(cmd: Command, path: string[] = []): Array<{ where: string; text: string }> {
  const here = [...path, cmd.name()].join(' ')
  let text = ''
  const saved = cmd.configureOutput()
  cmd.configureOutput({ writeOut: (s) => { text += s }, writeErr: (s) => { text += s } })
  try {
    cmd.outputHelp()
  } finally {
    cmd.configureOutput(saved)
  }
  const out = [{ where: here, text }]
  for (const sub of cmd.commands) out.push(...renderedHelp(sub, [...path, cmd.name()]))
  return out
}

describe('--help text', () => {
  it('has no internal issue numbers or Turkish notes', () => {
    const leaks = helpStrings(buildProgram()).filter((h) => /#\d+|\bFaz\b|phase \d/.test(h.text))
    expect(leaks).toEqual([])
  })

  it('renders no issue number in any command or subcommand help', () => {
    const pages = renderedHelp(buildProgram())
    expect(pages.length).toBeGreaterThan(50)
    expect(pages.every((p) => p.text.includes('Usage:'))).toBe(true)
    const leaks = pages
      .filter((p) => /#\d{2,}|\bFaz \d/.test(p.text))
      .map((p) => ({ where: p.where, match: p.text.match(/.{0,40}(#\d{2,}|\bFaz \d).{0,20}/)?.[0] }))
    expect(leaks).toEqual([])
  })

  it('the SOUL template an agent reads has no issue numbers', () => {
    expect(DEFAULT_FOREMAN_SOUL).not.toMatch(/#\d{2,}/)
    expect(DEFAULT_FOREMAN_SOUL).not.toMatch(/\bFaz \d/)
  })

  it('init --help shows where this machine keeps the home', () => {
    const home = mkdtempSync(join(tmpdir(), 'foreman-help-home-'))
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, NO_COLOR: '1' }
      const out = spawnSync('node', [FM_BIN, 'init', '--help'], { env, encoding: 'utf-8' })
      const dirs = resolveDirs({ homeDir: home, env, platform: process.platform as Platform })
      expect(out.stdout).not.toContain('~/.foreman')
      expect(out.stdout).toContain(`config  ${dirs.configDir}`)
      expect(out.stdout).toContain(`state   ${dirs.stateDir}`)
      const withHome = spawnSync('node', [FM_BIN, 'init', '--help'], {
        env: { ...env, FOREMAN_HOME: join(home, 'fh') },
        encoding: 'utf-8',
      })
      expect(withHome.stdout).toContain('FOREMAN_HOME is set')
      expect(withHome.stdout).toContain(`config  ${join(home, 'fh')}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('notify summary --now names the channels it really uses', () => {
    const out = spawnSync('node', [FM_BIN, 'notify', 'summary', '--help'], { encoding: 'utf-8' })
    expect(out.stdout).toContain('routed for `summary`')
    expect(out.stdout).not.toContain('every enabled channel')
  })
})

describe('what the help promises', () => {
  let home: string
  let saved: { fh?: string; skip?: string }
  beforeAll(() => {
    saved = { fh: process.env.FOREMAN_HOME, skip: process.env.FOREMAN_NO_UPDATE_CHECK }
  })
  afterAll(() => {
    if (saved.fh === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = saved.fh
    if (saved.skip === undefined) delete process.env.FOREMAN_NO_UPDATE_CHECK
    else process.env.FOREMAN_NO_UPDATE_CHECK = saved.skip
  })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-help-promise-'))
    process.env.FOREMAN_HOME = home
    delete process.env.FOREMAN_NO_UPDATE_CHECK
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('start --skip-setup remembers the choice', () => {
    expect(loadSetupState().skippedAt).toBeUndefined()
    rememberSetupSkipped()
    expect(typeof loadSetupState().skippedAt).toBe('number')
  })

  it("doctor's update hint names the Homebrew formula", () => {
    mkdirSync(join(home, 'cache'), { recursive: true })
    writeFileSync(join(home, 'cache', 'version-check.json'), JSON.stringify({ latest: '999.0.0', observedAt: Date.now() }))
    const row = checkUpdate()
    expect(row.status).toBe('warn')
    expect(row.remediation).toContain('brew upgrade foreman-agent')
  })
})
