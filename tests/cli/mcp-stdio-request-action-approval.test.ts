/**
 * Tests for the `request_action_approval` MCP tool (#552 PR 2).
 *
 * Coverage:
 *   - tools/list advertises the new tool with the expected schema.
 *   - tools/call (codex adapter) low-risk → mediator returns "allowed" →
 *     adapter encodes `accept`; structuredContent carries normalised
 *     metadata.
 *   - tools/call (codex adapter) high-risk → mediator returns "denied" →
 *     adapter encodes `decline`; structuredContent carries the deny
 *     reason.
 *   - tools/call (claude-code adapter) round-trip — same flow, different
 *     wire shape — proves the tool is genuinely adapter-agnostic.
 *   - Fail-closed paths: missing adapter_id → MCP -32602; unknown
 *     adapter id → -32602; missing wire → -32602; adapter decode error
 *     → reply with `isError: true` + adapter-encoded deny in
 *     structuredContent.wire (NOT a JSON-RPC error so the bridge can
 *     forward the deny verbatim to the agent).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  handleMessage,
  type McpStdioServices,
} from '../../src/cli/mcp-stdio.js'
import type {
  MediatorOutput,
  SecretGetOutput,
} from '../../src/core/mediator.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'
import type {
  CodexCommandExecutionRequestApprovalParams,
} from '../../src/core/adapters/index.js'

// =============================================================================
// Test harness — mirrors the existing mcp-stdio-handler.test.ts shape
// =============================================================================

function makeServices(
  decision: 'allowed' | 'denied',
  decidedBy = 'risk:auto-allow',
  opts: {
    riskScore?: number
    riskBucket?: MediatorOutput['riskBucket']
    riskReasons?: string[]
  } = {},
): McpStdioServices {
  const result: MediatorOutput = {
    requestId: 'req_abc123',
    decision,
    decidedBy,
    riskScore: opts.riskScore ?? 10,
    riskReasons: opts.riskReasons ?? [],
    riskFactors: [],
    riskBucket: opts.riskBucket ?? 'low',
    llmVerification: null,
    durationMs: 5,
  }
  return {
    mediator: {
      handleRequest: vi.fn(async () => result),
      handleSecretGet: vi.fn(
        async () =>
          ({ requestId: 'r', decision: 'denied', decidedBy: 'stub' }) as SecretGetOutput,
      ),
    },
    approval: { submitFromAgent: vi.fn(async () => ({ ok: true })) },
    commandRouter: { dispatch: vi.fn(async () => ({ ok: true, text: 'stub' })) },
    audit: { logEvent: vi.fn(), logRequest: vi.fn() },
    registry: { heartbeat: vi.fn() },
    llmConfigPath: '/tmp/test-llm.yaml',
    configDir: '/tmp/test-config',
  } as unknown as McpStdioServices
}

function codexCommandExecutionWire(
  cmd: string,
  overrides: Partial<CodexCommandExecutionRequestApprovalParams> = {},
): { method: string; params: CodexCommandExecutionRequestApprovalParams } {
  return {
    method: 'item/commandExecution/requestApproval',
    params: {
      itemId: 'item_test',
      threadId: 'thread_test',
      turnId: 'turn_test',
      startedAtMs: 1_700_000_000_000,
      command: cmd,
      cwd: '/tmp',
      reason: null,
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      availableDecisions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      approvalId: null,
      ...overrides,
    },
  }
}

// =============================================================================
// tools/list — advertisement
// =============================================================================

describe('mcp-stdio request_action_approval — tools/list', () => {
  it('advertises request_action_approval with adapter_id + wire inputs', async () => {
    const out = (await handleMessage(makeServices('allowed'), 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    } as JSONRPCMessage)) as unknown as {
      result: {
        tools: Array<{
          name: string
          description: string
          inputSchema: { required?: string[]; properties?: Record<string, unknown> }
        }>
      }
    }
    const tool = out.result.tools.find((t) => t.name === 'request_action_approval')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema.required).toEqual(['adapter_id', 'wire'])
    expect(tool!.inputSchema.properties).toHaveProperty('adapter_id')
    expect(tool!.inputSchema.properties).toHaveProperty('wire')
  })
})

// =============================================================================
// tools/call — happy path (codex)
// =============================================================================

describe('mcp-stdio request_action_approval — codex adapter, allow path', () => {
  it('routes low-risk through the mediator and returns accept wire response', async () => {
    const services = makeServices('allowed', 'risk:auto-allow', { riskBucket: 'low' })
    const out = (await handleMessage(services, 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: {
          adapter_id: 'codex-exec-server-v1',
          wire: codexCommandExecutionWire('ls /tmp'),
        },
      },
    } as JSONRPCMessage)) as unknown as {
      result: {
        content: Array<{ type: string; text: string }>
        structuredContent: {
          decision: string
          approval_id: string
          decided_by: string
          risk_score: number
          risk_bucket: string
          wire: { method: string; result: { decision: string } }
        }
      }
    }

    expect(services.mediator.handleRequest).toHaveBeenCalledTimes(1)
    const mediatorArg = vi.mocked(services.mediator.handleRequest).mock.calls[0]![0]
    expect(mediatorArg.sourceAgent).toBe('codex')
    expect(mediatorArg.targetTool).toBe('shell_exec')
    expect(mediatorArg.sessionId).toBe('thread_test')

    expect(out.result.structuredContent.decision).toBe('allow')
    expect(out.result.structuredContent.approval_id).toBe('req_abc123')
    expect(out.result.structuredContent.decided_by).toBe('risk:auto-allow')
    expect(out.result.structuredContent.risk_bucket).toBe('low')
    expect(out.result.structuredContent.wire.method).toBe(
      'item/commandExecution/requestApproval',
    )
    expect(out.result.structuredContent.wire.result.decision).toBe('accept')

    // The text content holds the JSON-stringified wire response so a
    // non-structuredContent-aware MCP client can still recover it.
    const textPayload = JSON.parse(out.result.content[0]!.text)
    expect(textPayload.result.decision).toBe('accept')
  })
})

describe('mcp-stdio request_action_approval — codex adapter, deny path', () => {
  it('routes high-risk denial through the mediator and returns decline wire response', async () => {
    const services = makeServices('denied', 'risk:auto-deny', {
      riskBucket: 'high',
      riskReasons: ['destructive_rm'],
    })
    const out = (await handleMessage(services, 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: {
          adapter_id: 'codex-exec-server-v1',
          wire: codexCommandExecutionWire('rm -rf /'),
        },
      },
    } as JSONRPCMessage)) as unknown as {
      result: {
        structuredContent: {
          decision: string
          reason?: string
          wire: { result: { decision: string } }
        }
      }
    }

    expect(out.result.structuredContent.decision).toBe('deny')
    expect(out.result.structuredContent.reason).toBe('destructive_rm')
    expect(out.result.structuredContent.wire.result.decision).toBe('decline')
  })

  it('falls back to "denied by <decidedBy>" when no risk reasons are provided', async () => {
    const services = makeServices('denied', 'policy:7', { riskReasons: [] })
    const out = (await handleMessage(services, 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: {
          adapter_id: 'codex-exec-server-v1',
          wire: codexCommandExecutionWire('echo policy-denied'),
        },
      },
    } as JSONRPCMessage)) as unknown as {
      result: { structuredContent: { reason?: string } }
    }
    expect(out.result.structuredContent.reason).toBe('denied by policy:7')
  })
})

// =============================================================================
// tools/call — claude-code adapter (proves agent-agnosticism)
// =============================================================================

describe('mcp-stdio request_action_approval — claude-code adapter', () => {
  it('decodes a PreToolUse payload and emits hookSpecificOutput on the wire', async () => {
    const services = makeServices('allowed')
    const out = (await handleMessage(services, 'claude-code', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: {
          adapter_id: 'claude-code-pretooluse-v1',
          wire: {
            session_id: 'sess_xyz',
            tool_name: 'Bash',
            tool_input: { command: 'echo hello' },
            tool_use_id: 'tu_42',
          },
        },
      },
    } as JSONRPCMessage)) as unknown as {
      result: {
        structuredContent: {
          decision: string
          wire: { hookSpecificOutput: { permissionDecision: string } }
        }
      }
    }

    const mediatorArg = vi.mocked(services.mediator.handleRequest).mock.calls[0]![0]
    expect(mediatorArg.targetTool).toBe('shell_exec')
    expect(mediatorArg.sessionId).toBe('sess_xyz')

    expect(out.result.structuredContent.decision).toBe('allow')
    expect(out.result.structuredContent.wire.hookSpecificOutput.permissionDecision).toBe(
      'allow',
    )
  })
})

// =============================================================================
// Fail-closed paths
// =============================================================================

describe('mcp-stdio request_action_approval — fail-closed paths', () => {
  it('rejects calls missing adapter_id with -32602', async () => {
    const out = (await handleMessage(makeServices('allowed'), 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: { wire: codexCommandExecutionWire('ls') },
      },
    } as JSONRPCMessage)) as unknown as { error: { code: number; message: string } }
    expect(out.error.code).toBe(-32602)
    expect(out.error.message).toContain('adapter_id')
  })

  it('rejects calls missing wire with -32602', async () => {
    const out = (await handleMessage(makeServices('allowed'), 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: { adapter_id: 'codex-exec-server-v1' },
      },
    } as JSONRPCMessage)) as unknown as { error: { code: number; message: string } }
    expect(out.error.code).toBe(-32602)
    expect(out.error.message).toContain('wire')
  })

  it('rejects unknown adapter_id with -32602 and lists known adapters', async () => {
    const out = (await handleMessage(makeServices('allowed'), 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: {
          adapter_id: 'nope-v999',
          wire: codexCommandExecutionWire('ls'),
        },
      },
    } as JSONRPCMessage)) as unknown as { error: { code: number; message: string } }
    expect(out.error.code).toBe(-32602)
    expect(out.error.message).toContain('nope-v999')
    expect(out.error.message).toContain('codex-exec-server-v1')
  })

  it('returns isError + adapter-encoded deny when the wire payload is malformed', async () => {
    const services = makeServices('allowed')
    const out = (await handleMessage(services, 'codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'request_action_approval',
        arguments: {
          adapter_id: 'codex-exec-server-v1',
          // itemId is required but empty — adapter rejects.
          wire: codexCommandExecutionWire('ls', { itemId: '' }),
        },
      },
    } as JSONRPCMessage)) as unknown as {
      result: {
        isError: boolean
        structuredContent: {
          decision: string
          reason: string
          wire: { result: { decision: string } }
        }
      }
    }

    // Mediator never runs — decode fails first.
    expect(services.mediator.handleRequest).not.toHaveBeenCalled()
    expect(out.result.isError).toBe(true)
    expect(out.result.structuredContent.decision).toBe('deny')
    expect(out.result.structuredContent.reason).toContain('itemId is required')
    // Adapter still encodes the deny so the bridge can forward verbatim.
    expect(out.result.structuredContent.wire.result.decision).toBe('decline')
  })
})
