import { EventEmitter } from 'node:events'

/**
 * Payload shapes for every v0.1 event. Adding a new event = add a key
 * here, then every callsite gets type-checked. Loose `string` / `unknown`
 * fields are reserved for fields that genuinely vary (e.g. tool args).
 */
export interface ForemanEventMap {
  'request:received': {
    requestId: string
    sourceAgent: string
    targetAgent?: string
    targetTool?: string
    args: unknown
    receivedAt: number
  }
  'request:decided': {
    requestId: string
    sourceAgent: string
    targetAgent?: string
    targetTool?: string
    args: unknown
    decision: 'allowed' | 'denied'
    decidedBy: string
    riskScore: number
    riskReasons: string[]
    result?: unknown
    durationMs: number
    decidedAt: number
  }
  'agent:registered': {
    agentId: string
    displayName: string
    transport: 'stdio' | 'ws'
    registeredAt: number
  }
  'agent:heartbeat': {
    agentId: string
    status: 'active' | 'inactive' | 'blocked'
    seenAt: number
  }
  'policy:changed': {
    ruleId: number
    sourceAgent: string
    target: string
    effect: 'allow' | 'deny' | 'ask'
    createdBy: 'user' | 'remember-action' | 'yaml'
    changedAt: number
  }
  'session:halted': {
    sessionId: string
    reason: 'turn_limit' | 'token_limit' | 'manual'
    turnCount: number
    tokenCount: number
    haltedAt: number
  }
  'approval:requested': {
    requestId: string
    sourceAgent: string
    targetAgent?: string
    targetTool?: string
    args: unknown
    riskScore: number
    riskReasons: string[]
  }
  'approval:resolved': {
    requestId: string
    decision: 'allowed' | 'denied'
    remember?: 'allow' | 'deny'
    resolvedBy: 'user' | 'timeout'
  }
}

export type ForemanEvent = keyof ForemanEventMap
export type Listener<T> = (payload: T) => void
export type Unsubscribe = () => void

/**
 * Thin typed wrapper around `EventEmitter`. `on()` returns an
 * unsubscribe function so callers don't have to keep both the handler
 * reference and the event name around.
 */
export class EventBus<EventMap> {
  private readonly emitter: EventEmitter

  constructor() {
    this.emitter = new EventEmitter()
    // Foreman is a single long-running process. The default cap of 10
    // listeners per event will trip in a real run once every service
    // subscribes; bump it up.
    this.emitter.setMaxListeners(100)
  }

  on<K extends keyof EventMap & string>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): Unsubscribe {
    this.emitter.on(event, listener as (payload: unknown) => void)
    return () => this.off(event, listener)
  }

  once<K extends keyof EventMap & string>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): Unsubscribe {
    this.emitter.once(event, listener as (payload: unknown) => void)
    return () => this.off(event, listener)
  }

  off<K extends keyof EventMap & string>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): void {
    this.emitter.off(event, listener as (payload: unknown) => void)
  }

  emit<K extends keyof EventMap & string>(
    event: K,
    payload: EventMap[K],
  ): void {
    this.emitter.emit(event, payload)
  }

  listenerCount<K extends keyof EventMap & string>(event: K): number {
    return this.emitter.listenerCount(event)
  }

  removeAllListeners<K extends keyof EventMap & string>(event?: K): void {
    if (event === undefined) this.emitter.removeAllListeners()
    else this.emitter.removeAllListeners(event)
  }
}

/** Default singleton — every service imports `bus` from here. */
export const bus = new EventBus<ForemanEventMap>()
