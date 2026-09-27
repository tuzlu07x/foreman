import { describe, expect, it } from 'vitest'
import { untrustedRelayRefusal } from '../../src/cli/mcp-stdio.js'

// #618 review — relay tools act for the human. An unverified connection
// may only relay what something else proves: a tagged approval button, or
// a read-only command.

const ULID = '01JAPPROVAL0000000000000000'.slice(0, 26)

describe('untrustedRelayRefusal', () => {
  it('lets verified agents through untouched', () => {
    for (const tool of ['submit_command', 'submit_resolution', 'submit_user_answer', 'submit_approval']) {
      expect(untrustedRelayRefusal('codex', tool, { command: 'write', approval_id: ULID })).toBeNull()
    }
  })

  it('refuses answers, resolutions and state-changing commands', () => {
    expect(untrustedRelayRefusal('untrusted:hermes', 'submit_user_answer', {})).toMatch(/needs a verified agent/)
    expect(untrustedRelayRefusal('untrusted:hermes', 'submit_resolution', {})).toMatch(/foreman agent rewire hermes/)
    for (const command of ['write', 'assign', 'stop', 'model', 'llm', 'tell', 'report', '']) {
      expect(untrustedRelayRefusal('untrusted:hermes', 'submit_command', { command })).not.toBeNull()
    }
  })

  it('allows read-only commands', () => {
    for (const command of ['help', 'status', 'Status ', 'org', 'spend', 'activity']) {
      expect(untrustedRelayRefusal('untrusted:hermes', 'submit_command', { command })).toBeNull()
    }
  })

  it('refuses an untagged approval decision but leaves a tagged one to the tag check', () => {
    expect(untrustedRelayRefusal('untrusted:hermes', 'submit_approval', { approval_id: ULID, decision: 'deny' })).toMatch(
      /without the tag/,
    )
    expect(untrustedRelayRefusal('untrusted:hermes', 'submit_approval', { approval_id: `${ULID}.abc123`, decision: 'allow' })).toBeNull()
  })

  it('ignores every other tool', () => {
    expect(untrustedRelayRefusal('untrusted:hermes', 'read_file', {})).toBeNull()
    expect(untrustedRelayRefusal('untrusted:hermes', 'org_post', {})).toBeNull()
  })
})
