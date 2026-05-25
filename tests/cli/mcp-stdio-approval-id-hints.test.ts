/**
 * submit_approval id-format hints (#552 PR 5).
 *
 * The chat surface fix in PR 5 has two halves: display (chat outbound
 * formats approval ids as `aprv_<ulid>`) and parse (submit_approval
 * strips the prefix + classifies the residual shape to enrich the
 * "not found" error message). This file covers the parse half end-to-
 * end via `handleMessage`. The display half is covered by the existing
 * telegram-channel tests + the `approval-id` unit tests.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  handleMessage,
  type McpStdioServices,
} from '../../src/cli/mcp-stdio.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

function makeApprovalServices(opts: {
  submitOk: boolean
  storeError?: string
}): McpStdioServices {
  return {
    mediator: {
      handleRequest: vi.fn(),
      handleSecretGet: vi.fn(),
    },
    approval: {
      submitFromAgent: vi.fn(async () =>
        opts.submitOk
          ? { ok: true }
          : { ok: false, error: opts.storeError ?? 'not found' },
      ),
    },
    commandRouter: { dispatch: vi.fn(async () => ({ ok: true, text: 'stub' })) },
    audit: { logEvent: vi.fn(), logRequest: vi.fn() },
    registry: { heartbeat: vi.fn() },
    llmConfigPath: '/tmp/test-llm.yaml',
    configDir: '/tmp/test-config',
  } as unknown as McpStdioServices
}

const VALID_ULID = '01HZX1234567890ABCDEFGHJKM'
// A copy of the actual codex session id from the #552 investigation —
// real-world example of the confusion this PR fixes.
const REAL_CODEX_SESSION = '019e5e5e-9ce6-7172-af2f-ff9cca12608a'

describe('submit_approval — aprv_ prefix stripping', () => {
  it('strips the aprv_ prefix before calling the approval store', async () => {
    const services = makeApprovalServices({ submitOk: true })
    await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: {
          approval_id: `aprv_${VALID_ULID}`,
          decision: 'allow',
        },
      },
    } as JSONRPCMessage)

    expect(services.approval.submitFromAgent).toHaveBeenCalledWith({
      approvalId: VALID_ULID,
      decision: 'allow',
      remember: false,
      sourceAgent: 'hermes',
    })
  })

  it('passes a bare ULID through unchanged (back-compat for older notifications)', async () => {
    const services = makeApprovalServices({ submitOk: true })
    await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: { approval_id: VALID_ULID, decision: 'allow' },
      },
    } as JSONRPCMessage)

    expect(services.approval.submitFromAgent).toHaveBeenCalledWith({
      approvalId: VALID_ULID,
      decision: 'allow',
      remember: false,
      sourceAgent: 'hermes',
    })
  })

  it('case-insensitively strips APRV_ when the user typed in caps', async () => {
    const services = makeApprovalServices({ submitOk: true })
    await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: {
          approval_id: `APRV_${VALID_ULID}`,
          decision: 'allow',
        },
      },
    } as JSONRPCMessage)

    const callArg = vi.mocked(services.approval.submitFromAgent).mock.calls[0]![0]
    expect(callArg.approvalId).toBe(VALID_ULID)
  })
})

describe('submit_approval — not-found hints (#552 PR 5)', () => {
  it('appends the agent-session hint when the input looks like a UUID', async () => {
    const services = makeApprovalServices({
      submitOk: false,
      storeError: 'approval not found',
    })
    const out = (await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: { approval_id: REAL_CODEX_SESSION, decision: 'allow' },
      },
    } as JSONRPCMessage)) as unknown as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }

    expect(out.result.isError).toBe(true)
    expect(out.result.content[0]!.text).toMatch(/approval not found/)
    expect(out.result.content[0]!.text).toMatch(/agent session/i)
    expect(out.result.content[0]!.text).toMatch(/ULID/)
  })

  it('appends the foreman-format hint when the input shape is right but the id is unknown', async () => {
    const services = makeApprovalServices({
      submitOk: false,
      storeError: 'approval not found',
    })
    const out = (await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: { approval_id: `aprv_${VALID_ULID}`, decision: 'allow' },
      },
    } as JSONRPCMessage)) as unknown as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }

    expect(out.result.isError).toBe(true)
    expect(out.result.content[0]!.text).toMatch(/format looks right/)
  })

  it('appends the unknown-format hint for arbitrary junk', async () => {
    const services = makeApprovalServices({
      submitOk: false,
      storeError: 'approval not found',
    })
    const out = (await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: { approval_id: 'hello-world', decision: 'allow' },
      },
    } as JSONRPCMessage)) as unknown as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }

    expect(out.result.isError).toBe(true)
    expect(out.result.content[0]!.text).toMatch(/does not match the Foreman approval format/)
  })

  it('the success path is unchanged — no hint appended when submit succeeds', async () => {
    const services = makeApprovalServices({ submitOk: true })
    const out = (await handleMessage(services, 'hermes', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_approval',
        arguments: { approval_id: `aprv_${VALID_ULID}`, decision: 'allow' },
      },
    } as JSONRPCMessage)) as unknown as {
      result: { content: Array<{ text: string }>; isError?: boolean }
    }

    expect(out.result.isError).toBeUndefined()
    expect(out.result.content[0]!.text).toMatch(/Submitted/)
    expect(out.result.content[0]!.text).not.toMatch(/agent session/i)
  })
})
