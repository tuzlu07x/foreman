import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { runInstallStep } from '../../src/tui/setup-wizard.js'

// #618 review M1 — a broken agent config holding a token must never have
// its content echoed: YAML errors carry a string `code` (BAD_INDENT) and
// quote the lines around the error, so "has a code" is not "filesystem
// error". Covers `agent add`, `rewire`, `token rotate` and the wizard log.

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')
const LEAKED = `fat_${'L'.repeat(43)}`

/** Hermes' config with a stale token and an indentation error near it. */
const BROKEN_YAML = [
  'model: x',
  'mcp_servers:',
  '  foreman:',
  '    command: foreman',
  '    env:',
  `      FOREMAN_AGENT_TOKEN: ${LEAKED}`,
  '     broken: [',
  '',
].join('\n')

describe('broken agent config never leaks its token', () => {
  let root: string
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [FM_BIN, ...args], { env, encoding: 'utf-8', input: '' })
  const output = (r: ReturnType<typeof run>): string => `${r.stdout}\n${r.stderr}`

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'foreman-parse-leak-'))
    home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(join(home, '.hermes'), { recursive: true })
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'node'))
    // No agent CLIs on PATH: nothing is probed or installed.
    env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      FOREMAN_HOME: join(root, 'foreman'),
      FOREMAN_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    }
    run('init')
    run('secrets', 'add', 'anthropic-key', '--value', 'sk-ant-not-real')
    writeFileSync(join(home, '.hermes', 'config.yaml'), BROKEN_YAML)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('agent add, rewire and token rotate', () => {
    const add = run('agent', 'add', 'hermes', '--type', 'hermes')
    expect(add.status).not.toBe(0)
    expect(output(add)).toContain("doesn't parse")
    expect(output(add)).not.toContain(LEAKED)

    expect(run('agent', 'add', 'hermes', '--type', 'hermes', '--skip-config').status).toBe(0)
    const rewire = run('agent', 'rewire', 'hermes')
    expect(rewire.status).toBe(1)
    expect(output(rewire)).toContain("doesn't parse")
    expect(output(rewire)).not.toContain(LEAKED)

    const rotate = run('agent', 'token', 'rotate', 'hermes', '--yes')
    expect(rotate.status).toBe(1)
    expect(output(rotate)).not.toContain(LEAKED)
    // The broken file is left alone.
    expect(readFileSync(join(home, '.hermes', 'config.yaml'), 'utf-8')).toBe(BROKEN_YAML)
  }, 60_000)
})

describe('broken agent config never leaks its token (wizard)', () => {
  let root: string
  let sqlite: Database.Database
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'foreman-parse-leak-wizard-'))
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(join(home, '.hermes'), { recursive: true })
    mkdirSync(bin)
    // A stand-in `hermes` so the wizard finds it installed and never runs
    // an installer; it only answers --version.
    writeFileSync(join(bin, 'hermes'), '#!/bin/sh\necho "hermes 9.9.9"\n')
    chmodSync(join(bin, 'hermes'), 0o755)
    writeFileSync(join(home, '.hermes', 'config.yaml'), BROKEN_YAML)
    process.env.HOME = home
    process.env.PATH = `${bin}:/usr/bin:/bin`
  })
  afterEach(() => {
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    sqlite?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('logs a sanitised message', async () => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    const bus = new EventBus<ForemanEventMap>()
    const logs: string[] = []
    await runInstallStep(
      ['hermes'],
      [],
      {
        db: handle.db,
        secretStore: new SecretStore(handle.db, Buffer.alloc(32, 7)),
        registry: new RegistryService(handle.db, bus),
        policyPath: join(root, 'policy.yaml'),
        llmConfigPath: join(root, 'llm.yaml'),
        notifyConfigPath: join(root, 'notify.yaml'),
        voiceConfigPath: join(root, 'voice.yaml'),
        launchEditor: vi.fn().mockResolvedValue(undefined) as () => Promise<unknown>,
      } as unknown as Parameters<typeof runInstallStep>[2],
      (line) => logs.push(line),
    )
    const text = logs.join('\n')
    expect(text).toContain("doesn't parse")
    expect(text).not.toContain(LEAKED)
  }, 30_000)
})
