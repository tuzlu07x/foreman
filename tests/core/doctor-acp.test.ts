/**
 * Tests for the `checkAcpAgents` doctor check (#445 / #552).
 *
 * Verifies each ACP-declared agent's binary is on PATH and reports
 * per-agent ok/warn rows so the operator sees exactly which install is
 * missing. The check fans out one row per agent — that's why it's
 * declared as `() => CheckResult[]` while the rest are
 * `() => CheckResult`.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAcpAgents } from '../../src/core/doctor.js'

describe('checkAcpAgents', () => {
  const ACP = ['hermes', 'openclaw', 'zeroclaw']

  it('emits one row per registered ACP agent', () => {
    // The bundled registry ships Hermes / OpenClaw / ZeroClaw as
    // ACP agents (see PR #567). With an empty PATH every row warns
    // — we use that to assert the expected agent ids surface.
    const rows = checkAcpAgents({ PATH: '/nowhere' }, ACP)
    const ids = new Set(rows.map((r) => r.name))
    expect(ids).toContain('acp:hermes')
    expect(ids).toContain('acp:openclaw')
    expect(ids).toContain('acp:zeroclaw')
    for (const row of rows) {
      expect(row.status).toBe('warn')
      expect(row.remediation).toMatch(/foreman write/)
    }
  })

  it('reports ok when an ACP agent binary is on PATH', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'foreman-acp-doctor-'))
    try {
      // Install a fake `hermes` binary so the check finds it.
      const fakeHermes = join(tmp, 'hermes')
      writeFileSync(fakeHermes, '#!/bin/sh\necho ok\n')
      chmodSync(fakeHermes, 0o755)
      const rows = checkAcpAgents({ PATH: tmp }, ACP)
      const hermesRow = rows.find((r) => r.name === 'acp:hermes')
      expect(hermesRow).toBeDefined()
      expect(hermesRow!.status).toBe('ok')
      expect(hermesRow!.message).toContain(fakeHermes)
      // Other ACP agents (openclaw / zeroclaw) still warn because
      // those binaries aren't in the tmp PATH.
      const openclawRow = rows.find((r) => r.name === 'acp:openclaw')
      expect(openclawRow!.status).toBe('warn')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // QA #657 M13 — a fresh box warned "Install Hermes … foreman write hermes
  // will fail" for three agents nobody registered.
  it('says nothing about ACP agents that are not registered', () => {
    expect(checkAcpAgents({ PATH: '/nowhere' }, [])).toEqual([
      { name: 'acp-agents', status: 'ok', message: 'no ACP-mediated agents registered' },
    ])
    const rows = checkAcpAgents({ PATH: '/nowhere' }, ['hermes', 'claude-code'])
    expect(rows.map((r) => r.name)).toEqual(['acp:hermes'])
  })
})
