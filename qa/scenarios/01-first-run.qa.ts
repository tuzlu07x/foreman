import { existsSync, statSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { Journey } from '../support/journey.js'
import { Sandbox } from '../support/sandbox.js'

interface DoctorReport {
  checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; message: string }>
  summary: { ok: number; warn: number; fail: number }
  exitCode: number
}

let sandbox: Sandbox | null = null
afterEach(async () => {
  await sandbox?.dispose()
  sandbox = null
})

it('First run: init, doctor, inbox', async ({ task }) => {
  const j = new Journey(
    task,
    'first-run',
    'A new user installs Foreman and runs `foreman init`, `foreman doctor` and `foreman inbox` on an empty home.',
  )
  const sb = (sandbox = await Sandbox.create('first-run'))

  await j.step('`foreman init` creates identity, policy, soul and audit database', (ev) => {
    const out = sb.ok(['init'])
    expect(out).toContain('Foreman initialised')
    for (const file of ['identity.key', 'policy.yaml', 'SOUL.md', 'foreman.db']) {
      expect(existsSync(sb.path(file)), file).toBe(true)
    }
    const mode = (file: string): string => (statSync(sb.path(file)).mode & 0o777).toString(8)
    expect(mode('identity.key')).toBe('600')
    expect(mode('foreman.db')).toBe('600')
    expect(mode('policy.yaml')).toBe('600')
    ev(`files: identity.key (mode ${mode('identity.key')}), policy.yaml (${mode('policy.yaml')}), SOUL.md, foreman.db (${mode('foreman.db')})`)
    const identity = /identity\s+\S+ \((ed25519:[0-9a-f]+)…?, new\)/.exec(out)
    expect(identity).not.toBeNull()
    ev(`init output: identity ${identity?.[1] ?? '?'} (new)`)
  })

  await j.step('the audit database starts empty and fully migrated', (ev) => {
    const tables = sb.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name)
    for (const t of ['requests', 'audit_events', 'pending_approvals', 'inbox_items', 'agent_usage', 'org_messages']) {
      expect(tables).toContain(t)
    }
    const [requests] = sb.query<{ n: number }>('SELECT count(*) AS n FROM requests')
    expect(requests?.n).toBe(0)
    ev(`${tables.length} tables incl. requests, audit_events, pending_approvals, inbox_items; requests rows: ${requests?.n}`)
    const tail = sb.json<unknown[]>(['log', 'tail', '--json'])
    expect(tail).toEqual([])
    ev('`foreman log tail --json` → []')
  })

  await j.step('`foreman doctor --json` reports no failures', (ev) => {
    const report = sb.json<DoctorReport>(['doctor', '--json'], { allowExit: [0, 1] })
    const failing = report.checks.filter((c) => c.status === 'fail')
    expect(failing).toEqual([])
    expect(report.summary.fail).toBe(0)
    expect(report.exitCode).toBeLessThan(2)
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]))
    for (const check of ['expected_files', 'identity_key', 'database', 'migrations', 'fts5', 'policy_yaml']) {
      expect(byName[check], check).toBe('ok')
    }
    const warnings = report.checks.filter((c) => c.status === 'warn').map((c) => c.name)
    ev(`summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail (exit ${report.exitCode})`)
    ev(`warnings: ${warnings.join(', ') || 'none'}`)
    ev('ok: expected_files, identity_key, database, migrations, fts5, policy_yaml')
  })

  await j.step('`foreman inbox` works on an empty inbox', (ev) => {
    const human = sb.ok(['inbox'])
    expect(human).toContain('Nothing here yet')
    expect(sb.json<unknown[]>(['inbox', '--json'])).toEqual([])
    expect(sb.ok(['inbox', 'read'])).toBeTruthy()
    ev('`foreman inbox` → "Nothing here yet"; `foreman inbox --json` → []; `foreman inbox read` exits 0')
  })

  await j.step('a second `foreman init` keeps the existing identity', (ev) => {
    const before = sb.read('identity.key')
    const out = sb.ok(['init'])
    expect(out).not.toContain(', new)')
    expect(sb.read('identity.key')).toBe(before)
    ev('identity.key unchanged after re-running init')
  })

  await j.step('nothing tried to reach the network', (ev) => {
    expect(sb.networkAttempts()).toEqual([])
    ev('network guard: 0 non-loopback connection attempts')
  })
})
