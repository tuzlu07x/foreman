import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockOAuthServer } from '../core/mcp-hub/fixtures/mock-oauth-server.js'

// End to end with the real CLI: `foreman mcp login` against a mock hosted
// MCP server + authorization server on 127.0.0.1, then the hub attaching the
// token upstream for `mcp tools` and a mediated call through `mcp-stdio`.
// Every piece of output is checked for token values afterwards.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FM_BIN = join(ROOT, 'dist/cli/index.js')

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

describe('foreman mcp login / logout (MCP OAuth)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  let mock: MockOAuthServer
  const outputs: string[] = []

  // Async spawn only: the mock server lives in this process.
  function run(args: string[], onStdout?: (chunk: string) => void): Promise<Run> {
    return new Promise((done) => {
      const child = spawn('node', [FM_BIN, ...args], { env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
        onStdout?.(stdout)
      })
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('exit', (code) => {
        outputs.push(stdout, stderr)
        done({ code, stdout, stderr })
      })
    })
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'foreman-mcp-oauth-e2e-'))
    env = {
      ...process.env,
      FOREMAN_HOME: home,
      FOREMAN_NO_UPDATE_CHECK: '1',
      FOREMAN_APPROVAL_TIMEOUT: '1',
      FOREMAN_HEADLESS: '1',
    }
    mock = new MockOAuthServer()
    await mock.start()
    outputs.length = 0
    await run(['init'])
  })

  afterEach(async () => {
    await mock.stop()
    rmSync(home, { recursive: true, force: true })
  })

  it('logs in, lets the hub use the session, and never shows a token anywhere', async () => {
    const added = await run(['mcp', 'add', 'hosted', '--url', mock.mcpUrl, '--oauth'])
    expect(added.code).toBe(0)
    expect(added.stdout).toContain('foreman mcp login hosted')
    const before = await run(['mcp', 'list'])
    expect(before.stdout).toContain('needs login')

    let approving: Promise<number> | null = null
    const login = await run(['mcp', 'login', 'hosted', '--no-browser', '--timeout', '20'], (out) => {
      const match = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(out)
      if (match && !approving) approving = mock.approve(match[1]!)
    })
    expect(login.stderr).toBe('')
    expect(login.code).toBe(0)
    expect(await approving).toBe(200)
    expect(login.stdout).toContain('hosted: logged in · expires in')

    const listed = await run(['mcp', 'list'])
    expect(listed.stdout).toMatch(/oauth: logged in · expires in/)
    const listedJson = await run(['mcp', 'list', '--json'])
    expect(JSON.parse(listedJson.stdout).servers.hosted.auth).toBe('oauth')
    const doctor = await run(['doctor', '--json'])
    expect(doctor.stdout).toContain('hosted: logged in')

    // The hub attaches the token upstream.
    const tools = await run(['mcp', 'tools', 'hosted', '--json'])
    const parsed = JSON.parse(tools.stdout) as { tools: Array<{ name: string; status: string }> }
    expect(parsed.tools.map((t) => t.name)).toEqual(['echo'])
    expect(mock.bearerSeen.length).toBeGreaterThan(0)

    // A mediated call from an agent, through mcp-stdio, with an allow rule.
    const yaml = readFileSync(join(home, 'mcp.yaml'), 'utf-8')
    expect(yaml).toContain('tools: {}')
    writeFileSync(join(home, 'mcp.yaml'), yaml.replace('tools: {}', 'tools:\n      allow: [echo]'))
    const rpc = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hosted__echo', arguments: { text: 'hello' } } },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n')
    const stdio = await runUntilReplies(['mcp-stdio', '--source', 'claude-code'], rpc, 2)
    expect(stdio).toContain('"text":"hello"')
    outputs.push(stdio)

    const audit = await run(['log', 'tail', '--json'])
    expect(audit.stdout).toContain('hosted__echo')

    // Nothing the authorization server issued shows up anywhere.
    const everything = [...outputs, readFileSync(join(home, 'mcp.yaml'), 'utf-8')].join('\n')
    expect(mock.allSecrets().length).toBeGreaterThan(2)
    for (const secret of mock.allSecrets()) expect(everything).not.toContain(secret)

    const logout = await run(['mcp', 'logout', 'hosted'])
    expect(logout.stdout).toContain('logged out of')
    const after = await run(['mcp', 'tools', 'hosted', '--refresh', '--json'])
    const status = (JSON.parse(after.stdout) as { servers: Array<{ error: string | null }> }).servers[0]!
    expect(status.error).toContain('foreman mcp login hosted')
  }, 60_000)

  it('refuses to log in to a server that is not marked auth: oauth', async () => {
    await run(['mcp', 'add', 'plain', '--url', mock.mcpUrl])
    const res = await run(['mcp', 'login', 'plain', '--no-browser'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('is not an OAuth server')
    expect(mock.calls.register).toBe(0)
  }, 30_000)

  function runUntilReplies(args: string[], input: string, replies: number): Promise<string> {
    return new Promise((done, fail) => {
      const child = spawn('node', [FM_BIN, ...args], { env })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        fail(new Error(`mcp-stdio did not answer: ${stderr}`))
      }, 30_000)
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
        if (stdout.split('\n').filter((l) => l.trim()).length >= replies) child.stdin.end()
      })
      child.on('exit', () => {
        clearTimeout(timer)
        outputs.push(stderr)
        done(stdout)
      })
      child.stdin.write(`${input}\n`)
    })
  }
})
