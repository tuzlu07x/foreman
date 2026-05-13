import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
  type Unsubscribe,
} from '../core/event-bus.js'
import { StdioTransport } from './stdio-transport.js'
import { isNotification, isRequest, type JSONRPCMessage } from './types.js'

export interface AttachOptions {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export class AgentAlreadyAttachedError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent already attached: ${agentId}`)
    this.name = 'AgentAlreadyAttachedError'
  }
}

export class AgentNotAttachedError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent not attached: ${agentId}`)
    this.name = 'AgentNotAttachedError'
  }
}

export class MCPGateway {
  private readonly transports = new Map<string, StdioTransport>()
  private readonly bus: EventBus<ForemanEventMap>
  private readonly subscriptions: Unsubscribe[] = []

  constructor(bus: EventBus<ForemanEventMap> = defaultBus) {
    this.bus = bus
  }

  attach(agentId: string, options: AttachOptions): void {
    if (this.transports.has(agentId)) throw new AgentAlreadyAttachedError(agentId)
    const transport = new StdioTransport({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      onMessage: (msg) => this.handleInbound(agentId, msg),
      onExit: (code, signal) => this.handleExit(agentId, code, signal),
      onError: () => this.handleExit(agentId, null, null),
    })
    transport.start()
    this.transports.set(agentId, transport)
  }

  detach(agentId: string): void {
    const transport = this.transports.get(agentId)
    if (!transport) return
    transport.stop()
    this.transports.delete(agentId)
  }

  send(agentId: string, message: JSONRPCMessage): void {
    const transport = this.transports.get(agentId)
    if (!transport) throw new AgentNotAttachedError(agentId)
    transport.send(message)
  }

  attached(): string[] {
    return Array.from(this.transports.keys())
  }

  isAttached(agentId: string): boolean {
    return this.transports.has(agentId)
  }

  dispose(): void {
    for (const off of this.subscriptions) off()
    this.subscriptions.length = 0
    for (const agentId of this.attached()) this.detach(agentId)
  }

  private handleInbound(agentId: string, msg: JSONRPCMessage): void {
    const receivedAt = Date.now()
    this.bus.emit('agent:message', { agentId, message: msg, receivedAt })
    if (isRequest(msg) || isNotification(msg)) {
      this.bus.emit('request:received', {
        requestId: isRequest(msg) ? String(msg.id) : `notif-${receivedAt}`,
        sourceAgent: agentId,
        targetTool: extractToolName(msg),
        args: 'params' in msg ? msg.params : undefined,
        receivedAt,
      })
    }
  }

  private handleExit(
    agentId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const disconnectedAt = Date.now()
    this.transports.delete(agentId)
    this.bus.emit('agent:heartbeat', {
      agentId,
      status: 'inactive',
      seenAt: disconnectedAt,
    })
    this.bus.emit('agent:disconnected', { agentId, code, signal, disconnectedAt })
  }
}

function extractToolName(msg: JSONRPCMessage): string | undefined {
  if (!('method' in msg)) return undefined
  if (msg.method !== 'tools/call') return msg.method
  const params = (msg as { params?: { name?: unknown } }).params
  return typeof params?.name === 'string' ? params.name : undefined
}
