import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeHubError } from '../../src/cli/mcp-cli.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// QA #657 L15 — `mcp add --url http://example.com/mcp` printed a raw zod
// JSON array of issues.
describe('foreman mcp add errors', () => {
  let home: string
  const run = (...args: string[]) =>
    spawnSync('node', [FM_BIN, ...args], { env: { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }, encoding: 'utf-8' })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-mcp-add-'))
    expect(run('init').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('says what is wrong with a plain-http URL in words', () => {
    const out = run('mcp', 'add', 'x', '--url', 'http://example.com/mcp')
    expect(out.status).toBe(1)
    expect(out.stderr.trim()).toBe(
      "error: server 'x': remote servers must use https:// (plain http is only allowed for localhost)",
    )
  })
})

describe('describeHubError', () => {
  it('names the server and the field of every issue', () => {
    const err = new z.ZodError([
      { code: 'custom', message: 'bad url', path: ['servers', 'gh', 'url'] },
      { code: 'custom', message: 'unknown mode', path: ['mode'] },
    ])
    expect(describeHubError(err)).toBe("server 'gh' (url): bad url; mode: unknown mode")
  })
})
