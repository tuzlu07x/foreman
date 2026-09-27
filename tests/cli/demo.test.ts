import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDemoLayout, DEMO_AGENTS, demoEnv, demoPath, type DemoLayout } from '../../src/cli/demo/demo-cli.js'
import { DEMO_SCRIPT, playDemo, type DemoActions } from '../../src/cli/demo/script.js'
import { DEMO_STUBS, writeDemoStubs } from '../../src/cli/demo/stubs.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// #632 — `foreman demo` plays a scripted day in a sandbox. It must never
// touch the real home, and must never reach a real agent CLI.

type Call = [string, ...unknown[]]

function recorder(fail?: keyof DemoActions): { actions: DemoActions; calls: Call[] } {
  const calls: Call[] = []
  const act =
    (name: keyof DemoActions) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args])
      if (name === fail) throw new Error(`${name} failed`)
    }
  return {
    calls,
    actions: {
      post: act('post'),
      report: act('report'),
      delegate: act('delegate'),
      toolCall: act('toolCall'),
      usage: act('usage'),
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

describe('foreman demo sandbox (#632)', () => {
  let parent: string
  let layout: DemoLayout

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'foreman-demo-test-'))
    layout = createDemoLayout(parent)
  })
  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('lays out home, stand-in agents and a work folder inside one throwaway directory', () => {
    expect(dirname(layout.root)).toBe(parent)
    for (const dir of [layout.home, layout.bin, layout.work]) expect(dirname(dir)).toBe(layout.root)
    expect(readdirSync(layout.bin).sort()).toEqual(Object.keys(DEMO_STUBS).sort())
    for (const name of Object.keys(DEMO_STUBS)) {
      expect(statSync(join(layout.bin, name)).mode & 0o111).not.toBe(0)
    }
    // Interpreters are absolute: nothing is looked up on PATH to run a stand-in.
    expect(readFileSync(join(layout.bin, 'claude'), 'utf-8').split('\n')[0]).toBe(`#!${process.execPath}`)
    expect(readFileSync(join(layout.bin, 'codex'), 'utf-8').split('\n')[0]).toBe('#!/bin/sh')
    // The decoy secret is fake and private.
    expect(readFileSync(join(layout.work, '.env'), 'utf-8')).toContain('sk_demo_not_a_real_key')
    expect(statSync(join(layout.work, '.env')).mode & 0o777).toBe(0o600)
  })

  it('runs every process against the demo home, with only stand-ins and system tools on PATH', () => {
    const env = demoEnv(layout, { PATH: '/opt/real-agents/bin:/usr/local/bin', FOREMAN_HOME: '/home/someone/.foreman', HOME: '/home/someone' }, 4555)
    expect(env.FOREMAN_HOME).toBe(layout.home)
    expect(env.PATH!.split(delimiter)).toEqual([layout.bin, '/usr/bin', '/bin'])
    expect(env.FOREMAN_OTLP_PORT).toBe('4555')
    expect(env.FOREMAN_DEMO).toBe('1')
    expect(env.FOREMAN_NO_UPDATE_CHECK).toBe('1')
  })

  it("never resolves a real agent CLI, even one sitting in the user's PATH", () => {
    const real = join(parent, 'real-bin')
    mkdirSync(real)
    for (const name of ['claude', 'codex', 'gemini']) {
      writeFileSync(join(real, name), '#!/bin/sh\necho REAL\n')
      chmodSync(join(real, name), 0o755)
    }
    const env = demoEnv(layout, { PATH: `${real}${delimiter}/usr/bin${delimiter}/bin` }, 4555)
    const which = (name: string) =>
      spawnSync('/bin/sh', ['-c', `command -v ${name} || echo none`], { env, encoding: 'utf-8' }).stdout.trim()
    expect(which('claude')).toBe(join(layout.bin, 'claude'))
    expect(which('codex')).toBe(join(layout.bin, 'codex'))
    // No stand-in: it refuses, even if one is installed in /usr/bin.
    expect(which('gemini')).toBe(join(layout.bin, 'gemini'))
    const gemini = spawnSync(join(layout.bin, 'gemini'), [], { env, encoding: 'utf-8' })
    expect(gemini.status).toBe(127)
    expect(gemini.stderr).toContain("isn't available in foreman demo")
    expect(which('npx')).toBe(join(layout.bin, 'npx'))
  })

  it("falls back to `env node` only when node's path can't sit in a shebang", () => {
    const odd = '/Applications/My Tools/node/bin/node'
    expect(demoPath(layout, odd).split(delimiter)).toEqual([layout.bin, '/usr/bin', '/bin', '/Applications/My Tools/node/bin'])
    const bin = join(parent, 'odd-bin')
    mkdirSync(bin)
    writeDemoStubs(bin, odd)
    expect(readFileSync(join(bin, 'claude'), 'utf-8').split('\n')[0]).toBe('#!/usr/bin/env node')
    expect(demoPath(layout, '/opt/node22/bin/node').split(delimiter)).toEqual([layout.bin, '/usr/bin', '/bin'])
  })

  it('stand-in Claude reports usage only to the local endpoint, and stand-in Codex prints its tokens', async () => {
    const received: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const run = (cmd: string, env: NodeJS.ProcessEnv) =>
      new Promise<{ stdout: string; stderr: string }>((res, rej) =>
        execFile(join(layout.bin, cmd), [], { env: { ...demoEnv(layout, {}, port), ...env } }, (err, stdout, stderr) =>
          err ? rej(err) : res({ stdout, stderr }),
        ),
      )
    try {
      const otel = {
        OTEL_EXPORTER_OTLP_HEADERS: 'x-foreman-usage-key=task-key',
        OTEL_RESOURCE_ATTRIBUTES: 'foreman.agent=claude-code,foreman.task=7',
      }
      const [local, elsewhere, codex] = await Promise.all([
        run('claude', { ...otel, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }),
        run('claude', { ...otel, OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${port}` }),
        run('codex', {}),
      ])
      expect(local.stdout).toContain('All green')
      expect(elsewhere.stdout).toContain('All green')
      expect(received).toHaveLength(1)
      expect(received[0]!.url).toBe('/v1/logs')
      expect(received[0]!.headers['x-foreman-usage-key']).toBe('task-key')
      const payload = JSON.parse(received[0]!.body) as { resourceLogs: Array<{ resource: { attributes: Array<{ key: string }> } }> }
      expect(payload.resourceLogs[0]!.resource.attributes.map((a) => a.key)).toEqual(['service.name', 'foreman.agent', 'foreman.task'])
      expect(received[0]!.body).toContain('claude_code.api_request')
      expect(codex.stdout).toContain('6 passed')
      expect(codex.stderr).toContain('tokens used: 48,213')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 15_000)
})

describe('the scripted day (#632)', () => {
  it('plays every step in order through the injected actions', async () => {
    const { actions, calls } = recorder()
    const seen: string[] = []
    await playDemo(actions, { workDir: '/demo/work', speed: 1_000, onStep: (s) => seen.push(s.label) })
    await flush()
    expect(seen).toEqual(DEMO_SCRIPT.map((s) => s.label))
    // Steps start in order but run concurrently (an approval must not hold
    // up the day), so a step's second action can land after the next step.
    expect(calls.map((c) => c[0]).sort()).toEqual([
      'post',
      'delegate',
      'usage',
      'post',
      'toolCall',
      'toolCall',
      'post',
      'usage',
      'post',
      'report',
      'usage',
      'report',
    ].sort())
    // The approval is about the demo's decoy secret, never a real file.
    expect(calls).toContainEqual(['toolCall', 'openclaw', 'read_file', { path: join('/demo/work', '.env') }])
    expect(calls).toContainEqual(['delegate', 'claude-code', 'codex', 'add tests for the new rate limiter'])
    expect(calls).toContainEqual(['post', 'openclaw', 'boss', 'Can we mention pricing in the launch post?', 'question'])
    // Every actor is one of the demo's own agents.
    const ids = new Set(DEMO_AGENTS.map((a) => a.id))
    for (const c of calls) expect(ids.has(String(c[1]))).toBe(true)
  })

  it('stops when the TUI closes', async () => {
    const { actions, calls } = recorder()
    const abort = new AbortController()
    let steps = 0
    await playDemo(actions, {
      workDir: '/demo/work',
      speed: 100,
      signal: abort.signal,
      onStep: () => {
        steps += 1
        if (steps === 3) abort.abort()
      },
    })
    await flush()
    expect(steps).toBe(3)
    expect(calls).toHaveLength(3)
  })

  it('keeps going when one step fails, and says which', async () => {
    const { actions, calls } = recorder('toolCall')
    const failed: string[] = []
    await playDemo(actions, { workDir: '/demo/work', speed: 1_000, onError: (s) => failed.push(s.label) })
    await flush()
    expect(failed).toHaveLength(2)
    // The day still reaches its last step, the CEO's report.
    expect(calls.filter((c) => c[0] === 'report' && c[1] === 'hermes')).toHaveLength(1)
  })
})

describe('foreman demo, the command (#632)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-demo-seed-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('seeds a startup org with a tight marketing budget and the demo agents', () => {
    expect(run('init').status).toBe(0)
    const seed = run('demo', '--internal-seed')
    expect(seed.status).toBe(0)
    const org = readFileSync(join(home, 'org.yaml'), 'utf-8')
    expect(org).toContain('Demo Robotics')
    expect(org).toMatch(/budget:\s*\n\s+daily_usd: 1\n\s+on_exceed: pause/)
    expect(run('org', 'validate').status).toBe(0)
    const db = new Database(join(home, 'foreman.db'), { readonly: true })
    const agents = db.prepare('SELECT id, model_version AS model FROM agents ORDER BY id').all() as Array<{ id: string; model: string | null }>
    db.close()
    expect(agents.map((a) => a.id)).toEqual(DEMO_AGENTS.map((a) => a.id).sort())
    // Codex prints only a token total; its model lets the report price it.
    expect(agents.find((a) => a.id === 'codex')?.model).toBe('gpt-5')
    // Seeding again is harmless.
    expect(run('demo', '--internal-seed').status).toBe(0)
  })

  it('rejects a speed that is not a sensible number', () => {
    for (const speed of ['abc', '0', '-2', '1000']) {
      const out = run('demo', '--speed', speed)
      expect(out.status).not.toBe(0)
      expect(out.stderr).toContain('use a number from 0.1 to 100')
    }
  })

  it('refuses to run without an interactive terminal, before creating anything', () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('foreman-demo-') && !n.startsWith('foreman-demo-seed-')).length
    const out = run('demo')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('needs an interactive terminal')
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('foreman-demo-') && !n.startsWith('foreman-demo-seed-')).length
    expect(after).toBe(before)
  })
})
