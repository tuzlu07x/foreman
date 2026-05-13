import { ulid } from 'ulid'
import type { MCPGateway } from '../mcp/gateway.js'
import type { JSONRPCMessage, JSONRPCRequest } from '../mcp/types.js'
import type { ApprovalService } from './approval.js'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from './event-bus.js'
import type { PolicyEngine } from './policy-engine.js'
import { RISK_THRESHOLD, type RiskScorer } from './risk-scorer.js'
import type { RegistryService } from './registry.js'

export interface MediatorInput {
  requestId?: string
  sourceAgent: string
  message: JSONRPCMessage
  targetAgent?: string
  targetTool?: string
  signedPayload?: Buffer | string
  signature?: Buffer
}

export interface MediatorOutput {
  requestId: string
  decision: 'allowed' | 'denied'
  decidedBy: string
  riskScore: number
  riskReasons: string[]
  result?: unknown
  durationMs: number
}

export interface MediatorDeps {
  registry: RegistryService
  policy: PolicyEngine
  risk: RiskScorer
  approval: ApprovalService
  gateway?: MCPGateway
  bus?: EventBus<ForemanEventMap>
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class MediatorService {
  private readonly bus: EventBus<ForemanEventMap>
  private readonly timeoutMs: number

  constructor(private readonly deps: MediatorDeps) {
    this.bus = deps.bus ?? defaultBus
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async handleRequest(input: MediatorInput): Promise<MediatorOutput> {
    const requestId = input.requestId ?? ulid()
    const createdAt = Date.now()

    if (!this.authenticate(input)) {
      return this.finalize({
        requestId,
        input,
        decision: 'denied',
        decidedBy: 'auth-failure',
        riskScore: 0,
        riskReasons: [],
        createdAt,
      })
    }

    const policyResult = this.deps.policy.evaluate({
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      targetTool: input.targetTool,
      args: this.argsFromMessage(input.message),
    })

    if (policyResult.decision === 'deny') {
      return this.finalize({
        requestId,
        input,
        decision: 'denied',
        decidedBy: `policy:${policyResult.matchedRuleId ?? 'unknown'}`,
        riskScore: 0,
        riskReasons: [],
        createdAt,
      })
    }

    const risk = this.deps.risk.score({
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      targetTool: input.targetTool,
      args: this.argsFromMessage(input.message),
    })

    let decision: 'allowed' | 'denied'
    let decidedBy: string

    const needsApproval =
      policyResult.decision === 'ask' || risk.score >= RISK_THRESHOLD

    if (needsApproval) {
      this.bus.emit('approval:requested', {
        requestId,
        sourceAgent: input.sourceAgent,
        targetAgent: input.targetAgent,
        targetTool: input.targetTool,
        args: this.argsFromMessage(input.message),
        riskScore: risk.score,
        riskReasons: risk.reasons,
      })
      const approval = await this.deps.approval.request({
        requestId,
        sourceAgent: input.sourceAgent,
        targetAgent: input.targetAgent,
        targetTool: input.targetTool,
        args: this.argsFromMessage(input.message),
        riskScore: risk.score,
        riskReasons: risk.reasons,
      })
      decision = approval.decision
      decidedBy = 'user'
      if (approval.remember && input.targetTool) {
        const target = input.targetAgent
          ? `${input.targetAgent}:${input.targetTool}`
          : `tool:${input.targetTool}`
        this.deps.policy.remember({
          sourceAgent: input.sourceAgent,
          target,
          effect: approval.remember,
        })
      }
    } else {
      decision = 'allowed'
      decidedBy = policyResult.matchedRuleId
        ? `policy:${policyResult.matchedRuleId}`
        : 'auto'
    }

    let result: unknown | undefined
    if (decision === 'allowed' && input.targetAgent && this.deps.gateway) {
      try {
        result = await this.forwardToTarget(input.targetAgent, input.message)
      } catch (err) {
        decision = 'denied'
        decidedBy = 'route-error'
        result = { error: err instanceof Error ? err.message : String(err) }
      }
    }

    return this.finalize({
      requestId,
      input,
      decision,
      decidedBy,
      riskScore: risk.score,
      riskReasons: risk.reasons,
      createdAt,
      result,
    })
  }

  private authenticate(input: MediatorInput): boolean {
    if (!input.signature || input.signedPayload === undefined) return true
    return this.deps.registry.authenticate(
      input.sourceAgent,
      input.signedPayload,
      input.signature,
    )
  }

  private argsFromMessage(message: JSONRPCMessage): unknown {
    if (!('params' in message)) return undefined
    const params = message.params as { arguments?: unknown } | undefined
    return params?.arguments ?? params
  }

  private forwardToTarget(
    targetAgent: string,
    message: JSONRPCMessage,
  ): Promise<unknown> {
    const gateway = this.deps.gateway
    if (!gateway) {
      return Promise.reject(new Error('No gateway configured'))
    }
    if (!('id' in message) || !('method' in message)) {
      return Promise.reject(new Error('Only requests can be forwarded'))
    }
    const expectedId = (message as JSONRPCRequest).id
    return new Promise((resolve, reject) => {
      let off: (() => void) | null = null
      const timer = setTimeout(() => {
        off?.()
        reject(new Error(`Timeout waiting for response from ${targetAgent}`))
      }, this.timeoutMs)
      off = this.bus.on('agent:message', (e) => {
        if (e.agentId !== targetAgent) return
        const msg = e.message as JSONRPCMessage
        if (!('id' in msg) || msg.id !== expectedId) return
        clearTimeout(timer)
        off?.()
        if ('result' in msg) resolve(msg.result)
        else if ('error' in msg) {
          reject(
            new Error(
              typeof msg.error === 'object' && msg.error !== null && 'message' in msg.error
                ? String((msg.error as { message: unknown }).message)
                : JSON.stringify(msg.error),
            ),
          )
        } else resolve(undefined)
      })
      try {
        gateway.send(targetAgent, message)
      } catch (err) {
        clearTimeout(timer)
        off?.()
        reject(err)
      }
    })
  }

  private finalize(args: {
    requestId: string
    input: MediatorInput
    decision: 'allowed' | 'denied'
    decidedBy: string
    riskScore: number
    riskReasons: string[]
    createdAt: number
    result?: unknown
  }): MediatorOutput {
    const decidedAt = Date.now()
    const durationMs = decidedAt - args.createdAt
    this.bus.emit('request:decided', {
      requestId: args.requestId,
      sourceAgent: args.input.sourceAgent,
      targetAgent: args.input.targetAgent,
      targetTool: args.input.targetTool,
      args: this.argsFromMessage(args.input.message),
      decision: args.decision,
      decidedBy: args.decidedBy,
      riskScore: args.riskScore,
      riskReasons: args.riskReasons,
      result: args.result,
      durationMs,
      createdAt: args.createdAt,
      decidedAt,
    })
    return {
      requestId: args.requestId,
      decision: args.decision,
      decidedBy: args.decidedBy,
      riskScore: args.riskScore,
      riskReasons: args.riskReasons,
      result: args.result,
      durationMs,
    }
  }
}
