import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEntry } from '../../src/core/registry-catalog.js'
import {
  autoRegisterMcp,
  buildMcpRegisterHint,
  writeMcpWrapperScript,
} from '../../src/core/agent-mcp-register-hint.js'

// =============================================================================
// Pure-logic tests for #298 — post-install MCP register hint
// =============================================================================
//
// Some partner runtimes (Hermes) maintain their own MCP server registry
// CLI-side. The wizard's install log surfaces the templated command after
// registration so the user knows the extra step.

function agent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: 'hermes',
    name: 'Hermes',
    tagline: 'tag',
    homepage: 'https://example.com',
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    llm_compat: [],
    mcp_compatible: true,
    supported_versions: '*',
    min_foreman_version: '0.1.0',
    ...overrides,
  }
}

describe('buildMcpRegisterHint', () => {
  it('returns null when agent has no mcp_register_cli (most agents)', () => {
    const result = buildMcpRegisterHint(
      'claude-code',
      agent({ id: 'claude-code', mcp_register_cli: undefined }),
    )
    expect(result).toBeNull()
  })

  it('returns the templated command + verify + note for Hermes', () => {
    const result = buildMcpRegisterHint(
      'hermes',
      agent({
        id: 'hermes',
        mcp_register_cli: {
          command_template:
            'hermes mcp add foreman --command foreman --args "mcp-stdio --source {agent_id}"',
          verify_template: 'hermes mcp list',
          note: 'Hermes keeps its own MCP registry separately.',
        },
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.command).toBe(
      'hermes mcp add foreman --command foreman --args "mcp-stdio --source hermes"',
    )
    expect(result!.verify).toBe('hermes mcp list')
    expect(result!.note).toBe('Hermes keeps its own MCP registry separately.')
  })

  it('substitutes {agent_id} with the actual registered id (not the catalog id)', () => {
    // User registered Hermes under a custom id like "my-hermes" via
    // `foreman agent add my-hermes --type hermes`. The --source must match
    // the actual id, not the catalog id.
    const result = buildMcpRegisterHint(
      'my-hermes',
      agent({
        id: 'hermes',
        mcp_register_cli: {
          command_template:
            'hermes mcp add foreman --command foreman --args "mcp-stdio --source {agent_id}"',
        },
      }),
    )
    expect(result!.command).toBe(
      'hermes mcp add foreman --command foreman --args "mcp-stdio --source my-hermes"',
    )
  })

  it('substitutes {agent_id} in verify_template too', () => {
    const result = buildMcpRegisterHint(
      'hermes',
      agent({
        mcp_register_cli: {
          command_template: 'cmd {agent_id}',
          verify_template: 'verify {agent_id}',
        },
      }),
    )
    expect(result!.verify).toBe('verify hermes')
  })

  it('returns null verify + note when those fields are absent', () => {
    const result = buildMcpRegisterHint(
      'x',
      agent({
        mcp_register_cli: { command_template: 'cmd {agent_id}' },
      }),
    )
    expect(result!.verify).toBeNull()
    expect(result!.note).toBeNull()
  })

  it('replaces multiple {agent_id} occurrences in the template', () => {
    const result = buildMcpRegisterHint(
      'foo',
      agent({
        mcp_register_cli: {
          command_template: 'first {agent_id} second {agent_id} done',
        },
      }),
    )
    expect(result!.command).toBe('first foo second foo done')
  })

  // #346 — Hermes' --args parsing mangles multi-token strings, so the
  // documented `--args "mcp-stdio --source X"` never connects. The wrapper
  // option writes a tiny exec-style script and points Hermes at the path.
  describe('wrapper (#346)', () => {
    it('returns wrapper payload + substitutes {wrapper_path} in command_template', () => {
      const result = buildMcpRegisterHint(
        'hermes',
        agent({
          mcp_register_cli: {
            command_template: 'hermes mcp add foreman --command {wrapper_path}',
            wrapper: {
              path_template: '~/.foreman/wrappers/{agent_id}-mcp.sh',
              content_template:
                '#!/usr/bin/env bash\nexec foreman mcp-stdio --source {agent_id}\n',
            },
          },
        }),
        { homeDir: '/tmp/fake-home' },
      )
      expect(result!.wrapper).not.toBeNull()
      expect(result!.wrapper!.path).toBe(
        '/tmp/fake-home/.foreman/wrappers/hermes-mcp.sh',
      )
      expect(result!.wrapper!.content).toBe(
        '#!/usr/bin/env bash\nexec foreman mcp-stdio --source hermes\n',
      )
      expect(result!.command).toBe(
        'hermes mcp add foreman --command /tmp/fake-home/.foreman/wrappers/hermes-mcp.sh',
      )
    })

    it('returns wrapper: null when the agent has no wrapper block', () => {
      const result = buildMcpRegisterHint(
        'hermes',
        agent({
          mcp_register_cli: {
            command_template: 'cmd {agent_id}',
          },
        }),
      )
      expect(result!.wrapper).toBeNull()
    })

    it('uses the custom registered id in both path and content', () => {
      const result = buildMcpRegisterHint(
        'my-hermes',
        agent({
          id: 'hermes',
          mcp_register_cli: {
            command_template: '{wrapper_path}',
            wrapper: {
              path_template: '~/.foreman/wrappers/{agent_id}-mcp.sh',
              content_template: 'exec foreman mcp-stdio --source {agent_id}\n',
            },
          },
        }),
        { homeDir: '/tmp/h' },
      )
      expect(result!.wrapper!.path).toBe(
        '/tmp/h/.foreman/wrappers/my-hermes-mcp.sh',
      )
      expect(result!.wrapper!.content).toBe(
        'exec foreman mcp-stdio --source my-hermes\n',
      )
    })
  })
})

describe('writeMcpWrapperScript', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-wrapper-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the parent dir, writes content, and chmod +x', () => {
    const path = join(dir, 'wrappers', 'hermes-mcp.sh')
    const wrote = writeMcpWrapperScript({
      path,
      content: '#!/usr/bin/env bash\nexec foreman mcp-stdio --source hermes\n',
    })
    expect(wrote).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('--source hermes')
    // Owner exec bit must be set.
    const mode = statSync(path).mode & 0o111
    expect(mode).not.toBe(0)
  })

  it('is idempotent — no rewrite when existing content matches', () => {
    const path = join(dir, 'hermes-mcp.sh')
    const content = '#!/usr/bin/env bash\nexec foo\n'
    expect(writeMcpWrapperScript({ path, content })).toBe(true)
    expect(writeMcpWrapperScript({ path, content })).toBe(false)
  })

  it('overwrites when content drifted from previous version', () => {
    const path = join(dir, 'hermes-mcp.sh')
    expect(writeMcpWrapperScript({ path, content: 'v1\n' })).toBe(true)
    expect(writeMcpWrapperScript({ path, content: 'v2\n' })).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('v2\n')
  })
})

// #460 — autoRegisterMcp wraps the user-facing register command with a
// piped "y\n" so the agent's "[Y/n]" prompt auto-confirms. Best-effort.
describe('autoRegisterMcp (#460)', () => {
  it('returns ok=true when runShell succeeds + pipes y\\n', async () => {
    const runShell = vi.fn(async () => ({ ok: true, exitCode: 0 }))
    const outcome = await autoRegisterMcp(
      'hermes mcp add foreman --command /tmp/wrap.sh',
      runShell as never,
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.command).toBe(
      "printf 'y\\n' | hermes mcp add foreman --command /tmp/wrap.sh",
    )
    expect(runShell).toHaveBeenCalledOnce()
  })

  it('captures the first non-empty output line for logging', async () => {
    const runShell = vi.fn(
      async (
        _cmd: string,
        onLine?: (line: string) => void,
      ): Promise<{ ok: boolean; exitCode: number }> => {
        onLine?.('')
        onLine?.('  ')
        onLine?.('Connecting to foreman...')
        onLine?.('Found 3 tool(s)')
        return { ok: true, exitCode: 0 }
      },
    )
    const outcome = await autoRegisterMcp(
      'hermes mcp add foreman --command /tmp/x',
      runShell as never,
    )
    expect(outcome.firstOutputLine).toBe('Connecting to foreman...')
  })

  it('returns ok=false with exit code when runShell fails', async () => {
    const runShell = vi.fn(async () => ({ ok: false, exitCode: 1 }))
    const outcome = await autoRegisterMcp(
      'hermes mcp add foreman --command /tmp/x',
      runShell as never,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('exit 1')
  })

  it('returns ok=false when runShell throws', async () => {
    const runShell = vi.fn(async () => {
      throw new Error('binary not found')
    })
    const outcome = await autoRegisterMcp(
      'hermes mcp add foreman --command /tmp/x',
      runShell as never,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('binary not found')
  })
})
