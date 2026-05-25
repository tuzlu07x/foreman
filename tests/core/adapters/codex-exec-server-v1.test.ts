import { describe, expect, it } from 'vitest'
import {
  codexExecServerV1Adapter,
  AdapterDecodeError,
  type CodexCommandExecutionRequestApprovalParams,
  type CodexFileChangeRequestApprovalParams,
  type CodexPermissionsRequestApprovalParams,
} from '../../../src/core/adapters/index.js'

// =============================================================================
// Decode — codex wire → normalised
// =============================================================================

describe('codex-exec-server-v1 adapter — decodeRequest', () => {
  it('maps CommandExecutionRequestApproval to shell_exec with cmd + cwd', () => {
    const params: CodexCommandExecutionRequestApprovalParams = {
      itemId: 'item_abc',
      threadId: 'thread_xyz',
      turnId: 'turn_1',
      startedAtMs: 1_700_000_000_000,
      command: 'rm -rf /tmp/scratch',
      cwd: '/Users/fatih/work',
      reason: 'cleanup before build',
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      availableDecisions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      approvalId: null,
    }

    const out = codexExecServerV1Adapter.decodeRequest(
      { method: 'item/commandExecution/requestApproval', params },
      'codex',
    )

    expect(out.sourceAgent).toBe('codex')
    expect(out.targetTool).toBe('shell_exec')
    expect(out.args.cmd).toBe('rm -rf /tmp/scratch')
    expect(out.args.cwd).toBe('/Users/fatih/work')
    expect(out.approvalId).toBe('item_abc')
    expect(out.sessionId).toBe('thread_xyz')
    expect(out.reason).toBe('cleanup before build')
  })

  it('uses approvalId over itemId when codex disambiguates multi-callback approvals', () => {
    const params: CodexCommandExecutionRequestApprovalParams = {
      itemId: 'parent_item',
      threadId: 't',
      turnId: 'tn',
      startedAtMs: 1,
      command: 'echo hi',
      cwd: null,
      reason: null,
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      availableDecisions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      approvalId: 'child_callback_42',
    }

    const out = codexExecServerV1Adapter.decodeRequest(
      { method: 'item/commandExecution/requestApproval', params },
      'codex',
    )

    expect(out.approvalId).toBe('child_callback_42')
  })

  it('surfaces network host + protocol on the normalised args when present', () => {
    const params: CodexCommandExecutionRequestApprovalParams = {
      itemId: 'i',
      threadId: 't',
      turnId: 'tn',
      startedAtMs: 1,
      command: 'curl https://example.com',
      cwd: null,
      reason: null,
      commandActions: null,
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
      additionalPermissions: null,
      availableDecisions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      approvalId: null,
    }

    const out = codexExecServerV1Adapter.decodeRequest(
      { method: 'item/commandExecution/requestApproval', params },
      'codex',
    )

    expect(out.args.networkHost).toBe('example.com')
    expect(out.args.networkProtocol).toBe('https')
  })

  it('maps FileChangeRequestApproval to file_write with first path canonicalised', () => {
    const params: CodexFileChangeRequestApprovalParams = {
      itemId: 'fc_1',
      threadId: 't',
      turnId: 'tn',
      reason: null,
      changes: [
        { path: '/Users/fatih/work/foo.ts', kind: 'add' },
        { path: '/Users/fatih/work/bar.ts', kind: 'modify' },
      ],
    }

    const out = codexExecServerV1Adapter.decodeRequest(
      { method: 'item/fileChange/requestApproval', params },
      'codex',
    )

    expect(out.targetTool).toBe('file_write')
    expect(out.args.path).toBe('/Users/fatih/work/foo.ts')
    expect(out.args.paths).toEqual([
      '/Users/fatih/work/foo.ts',
      '/Users/fatih/work/bar.ts',
    ])
    expect(out.args.kinds).toEqual(['add', 'modify'])
  })

  it('maps PermissionsRequestApproval to permission_overlay', () => {
    const params: CodexPermissionsRequestApprovalParams = {
      itemId: 'p_1',
      threadId: 't',
      turnId: 'tn',
      startedAtMs: 1,
      cwd: '/tmp',
      permissions: { network: { enabled: true } },
    }

    const out = codexExecServerV1Adapter.decodeRequest(
      { method: 'item/permissions/requestApproval', params },
      'codex',
    )

    expect(out.targetTool).toBe('permission_overlay')
    expect(out.args.cwd).toBe('/tmp')
    expect(out.args.permissions).toEqual({ network: { enabled: true } })
  })

  it('throws AdapterDecodeError on missing itemId — fail-closed on malformed payloads', () => {
    expect(() =>
      codexExecServerV1Adapter.decodeRequest(
        {
          method: 'item/commandExecution/requestApproval',
          params: {
            itemId: '',
            threadId: 't',
            turnId: 'tn',
            startedAtMs: 1,
            command: null,
            cwd: null,
            reason: null,
            commandActions: null,
            networkApprovalContext: null,
            additionalPermissions: null,
            availableDecisions: null,
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
            approvalId: null,
          },
        },
        'codex',
      ),
    ).toThrow(AdapterDecodeError)
  })
})

// =============================================================================
// Encode — normalised → codex wire
// =============================================================================

describe('codex-exec-server-v1 adapter — encodeDecision (commandExecution)', () => {
  it('maps allow → accept', () => {
    const out = codexExecServerV1Adapter.encodeDecision(
      { kind: 'allow' },
      'item_1',
    )
    expect(out).toEqual({
      method: 'item/commandExecution/requestApproval',
      result: { decision: 'accept' },
    })
  })

  it('maps allow_for_session → acceptForSession', () => {
    const out = codexExecServerV1Adapter.encodeDecision(
      { kind: 'allow_for_session' },
      'item_1',
    )
    if (out.method !== 'item/commandExecution/requestApproval') {
      throw new Error('expected commandExecution wire response')
    }
    expect(out.result.decision).toBe('acceptForSession')
  })

  it('maps deny → decline', () => {
    const out = codexExecServerV1Adapter.encodeDecision(
      { kind: 'deny', reason: 'destructive' },
      'item_1',
    )
    if (out.method !== 'item/commandExecution/requestApproval') {
      throw new Error('expected commandExecution wire response')
    }
    expect(out.result.decision).toBe('decline')
  })

  it('maps deny_and_interrupt → cancel', () => {
    const out = codexExecServerV1Adapter.encodeDecision(
      { kind: 'deny_and_interrupt', reason: 'user halted session' },
      'item_1',
    )
    if (out.method !== 'item/commandExecution/requestApproval') {
      throw new Error('expected commandExecution wire response')
    }
    expect(out.result.decision).toBe('cancel')
  })
})

describe('codex-exec-server-v1 adapter — encodeDecision (fileChange / permissions)', () => {
  it('collapses allow_for_session onto accept for file_change (no session variant)', () => {
    // Cast the helper into a shape that allows the second-arg call; the
    // adapter's public interface accepts an optional third arg with the
    // method name.
    const adapter = codexExecServerV1Adapter as unknown as {
      encodeDecision: (
        decision: { kind: 'allow' | 'allow_for_session' | 'deny' | 'deny_and_interrupt'; reason?: string },
        approvalId: string,
        method?: string,
      ) => { method: string; result: { decision: string } }
    }
    const out = adapter.encodeDecision(
      { kind: 'allow_for_session' },
      'fc_1',
      'item/fileChange/requestApproval',
    )
    expect(out.result.decision).toBe('accept')
  })

  it('encodes a permissions deny_and_interrupt as cancel', () => {
    const adapter = codexExecServerV1Adapter as unknown as {
      encodeDecision: (
        decision: { kind: 'allow' | 'allow_for_session' | 'deny' | 'deny_and_interrupt'; reason?: string },
        approvalId: string,
        method?: string,
      ) => { method: string; result: { decision: string } }
    }
    const out = adapter.encodeDecision(
      { kind: 'deny_and_interrupt', reason: 'sandbox escape rejected' },
      'p_1',
      'item/permissions/requestApproval',
    )
    expect(out.result.decision).toBe('cancel')
  })
})

// =============================================================================
// Identity
// =============================================================================

describe('codex-exec-server-v1 adapter — identity', () => {
  it('exposes a stable id and label', () => {
    expect(codexExecServerV1Adapter.id).toBe('codex-exec-server-v1')
    expect(codexExecServerV1Adapter.label).toContain('Codex')
  })
})
