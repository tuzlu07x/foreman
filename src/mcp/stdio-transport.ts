import { spawn, type ChildProcess } from 'node:child_process'
import { createDecoder, encodeMessage, type MessageDecoder } from './framing.js'
import type { JSONRPCMessage } from './types.js'

export interface StdioTransportOptions {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  onMessage: (msg: JSONRPCMessage) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onError?: (err: Error) => void
  onRejected?: (line: string) => void
}

export class StdioTransport {
  private proc: ChildProcess | null = null
  private decoder: MessageDecoder = createDecoder()
  private exited = false
  private writeQueue: string[] = []
  private waitingDrain = false

  constructor(private readonly opts: StdioTransportOptions) {}

  start(): void {
    if (this.proc) throw new Error('StdioTransport already started')
    const proc = spawn(this.opts.command, this.opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.opts.env ?? process.env,
      cwd: this.opts.cwd,
    })
    this.proc = proc
    proc.stdout?.on('data', (chunk: Buffer) => {
      const { messages, rejected } = this.decoder.push(chunk)
      for (const m of messages) this.opts.onMessage(m)
      if (this.opts.onRejected) for (const r of rejected) this.opts.onRejected(r)
    })
    proc.stderr?.on('data', () => {})
    proc.on('exit', (code, signal) => {
      this.exited = true
      this.waitingDrain = false
      this.writeQueue.length = 0
      this.opts.onExit?.(code, signal)
    })
    proc.on('error', (err) => {
      this.exited = true
      this.waitingDrain = false
      this.writeQueue.length = 0
      this.opts.onError?.(err)
    })
    proc.stdin?.on('error', (err) => {
      // A child can close stdin before its exit event (common when a nested
      // agent tears down its MCP server). Mark the transport terminal so a
      // queued drain callback cannot write into a closed pipe or re-emit stale
      // frames during the next attach cycle.
      this.exited = true
      this.waitingDrain = false
      this.writeQueue.length = 0
      this.opts.onError?.(err)
    })
  }

  send(message: JSONRPCMessage): void {
    if (!this.proc || this.exited) throw new Error('Transport not alive')
    const line = encodeMessage(message)
    if (this.waitingDrain) {
      this.writeQueue.push(line)
      return
    }
    const ok = this.proc.stdin?.write(line) ?? false
    if (!ok) this.waitForDrain()
  }

  stop(): void {
    if (!this.proc || this.exited) return
    this.exited = true
    this.waitingDrain = false
    this.writeQueue.length = 0
    try {
      this.proc.stdin?.end()
    } catch {
      /* stdin may already be closed */
    }
    if (!this.proc.killed) this.proc.kill()
  }

  isAlive(): boolean {
    return this.proc !== null && !this.exited
  }

  pid(): number | undefined {
    return this.proc?.pid
  }

  private waitForDrain(): void {
    this.waitingDrain = true
    this.proc?.stdin?.once('drain', () => this.flushQueue())
  }

  private flushQueue(): void {
    if (this.exited || !this.proc) {
      this.waitingDrain = false
      this.writeQueue.length = 0
      return
    }
    this.waitingDrain = false
    while (this.writeQueue.length > 0) {
      const line = this.writeQueue.shift()!
      const ok = this.proc?.stdin?.write(line) ?? false
      if (!ok) {
        this.waitForDrain()
        return
      }
    }
  }
}
