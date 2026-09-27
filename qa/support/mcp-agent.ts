import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOREMAN_BIN, type Sandbox } from './sandbox.js'

// =============================================================================
// A scripted MCP agent: speaks newline-delimited JSON-RPC to
// `foreman mcp-stdio --source <agent>`, exactly like Claude Code or Codex
// would over their MCP connection.
// =============================================================================

export interface RpcContent {
  type: string
  text?: string
}

export interface RpcResponse {
  id: number
  result?: {
    content?: RpcContent[]
    tools?: Array<{ name: string; description?: string }>
    isError?: boolean
    structuredContent?: unknown
  }
  error?: { code: number; message: string }
}

export class McpAgent {
  private buffer = ''
  private nextId = 1
  private readonly waiters = new Map<number, (r: RpcResponse) => void>()
  private stderrText = ''
  private exited: Promise<number | null>

  private constructor(
    readonly source: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as RpcResponse
        this.waiters.get(msg.id)?.(msg)
        this.waiters.delete(msg.id)
      }
    })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrText = (this.stderrText + chunk).slice(-8_000)
    })
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  }

  /** Start `foreman mcp-stdio --source <source>` and complete the handshake.
   *  The agent proves its id with its token (#618), registering it first
   *  when needed; `untrusted` connects without one. */
  static async connect(
    sandbox: Sandbox,
    source: string,
    env: Record<string, string> = {},
    opts: { untrusted?: boolean } = {},
  ): Promise<McpAgent> {
    const token = opts.untrusted ? null : agentToken(sandbox, source)
    const child = spawn(process.execPath, [FOREMAN_BIN, 'mcp-stdio', '--source', source], {
      cwd: sandbox.cwd,
      env: { ...sandbox.env, ...(token ? { FOREMAN_AGENT_TOKEN: token } : {}), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const agent = new McpAgent(source, child)
    sandbox.onDispose(() => agent.kill())
    const init = await agent.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `qa-${source}`, version: '1.0.0' },
    })
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`)
    return agent
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<RpcResponse> {
    const id = this.nextId++
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`${this.source}: no reply to ${method} within ${timeoutMs} ms. stderr: ${this.stderrText}`))
      }, timeoutMs)
      this.waiters.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async toolNames(): Promise<string[]> {
    const res = await this.request('tools/list')
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`)
    return (res.result?.tools ?? []).map((t) => t.name)
  }

  call(name: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<RpcResponse> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }

  /** Close stdin (the agent went away) and wait for a clean exit. */
  async close(timeoutMs = 10_000): Promise<number | null> {
    this.child.stdin.end()
    const timer = setTimeout(() => this.kill(), timeoutMs)
    const code = await this.exited
    clearTimeout(timer)
    return code
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }
}

/** The text an agent would see: tool output, or the JSON-RPC error. */
export function replyText(res: RpcResponse): string {
  if (res.error) return `error: ${res.error.message}`
  return (res.result?.content ?? []).map((c) => c.text ?? '').join('\n')
}

/** Register `source` the way a user does (`foreman agent add`, as a generic
 *  MCP agent so no agent binary is probed) and keep its token for connect. */
export function agentToken(sandbox: Sandbox, source: string): string {
  const dir = join(sandbox.root, 'tokens')
  const file = join(dir, source)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    sandbox.ok(['agent', 'add', source, '--type', 'generic-mcp', '--skip-config', '--token-out', file])
  }
  return readFileSync(file, 'utf-8').trim()
}

/** An agent that is registered, connects once and leaves. */
export async function registerAgent(sandbox: Sandbox, source: string): Promise<void> {
  const agent = await McpAgent.connect(sandbox, source)
  await agent.close()
}
