import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentUsageKey } from '../../src/core/usage/agent-key.js'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// #629 — grow the org from the CLI, set budgets, read spend and reports.

describe('foreman org / usage (#629)', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const run = (...args: string[]) => spawnSync('node', [FM_BIN, ...args], { env, encoding: 'utf-8' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-org-spend-'))
    env = { ...process.env, FOREMAN_HOME: home, NO_COLOR: '1' }
    expect(run('init').status).toBe(0)
    expect(run('org', 'init', '--template', 'startup', '--company', 'Acme').status).toBe(0)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('adds departments and roles in one line each, keeping comments, and never writes an invalid chart', () => {
    const before = readFileSync(join(home, 'org.yaml'), 'utf-8')
    expect(before).toContain('#')
    const dept = run('org', 'add-department', 'sales', '--head', 'cso', '--agent', 'codex', '--name', 'Sales')
    expect(dept.status).toBe(0)
    expect(dept.stdout).toContain('added sales, led by cso')
    const role = run('org', 'add-role', 'sdr', '--agent', 'hermes', '--department', 'sales', '--title', 'SDR')
    expect(role.status).toBe(0)
    expect(role.stdout).toContain('reporting to cso')
    const yaml = readFileSync(join(home, 'org.yaml'), 'utf-8')
    expect(yaml).toContain('#') // comments survive
    expect(run('org', 'validate').status).toBe(0)
    const show = run('org', 'show')
    expect(show.stdout).toContain('cso')
    expect(show.stdout).toContain('sdr')

    expect(run('org', 'add-role', 'x', '--agent', 'codex', '--reports-to', 'nobody').status).toBe(1)
    expect(run('org', 'add-department', 'ops', '--head', 'coo').stderr).toContain('--agent')
    expect(readFileSync(join(home, 'org.yaml'), 'utf-8')).toBe(yaml)
  })

  it('sets and removes budgets', () => {
    expect(run('org', 'budget', 'marketing', '25', '--pause').stdout).toContain('marketing: $25 per month')
    expect(run('org', 'budget', 'marketing', '2', '--daily').status).toBe(0)
    expect(run('org', 'budget', 'marketing').stdout).toContain('$25/month $2/day (pause)')
    expect(run('org', 'budget', 'nowhere', '5').stderr).toContain("no department 'nowhere'")
    expect(run('org', 'budget', 'marketing', 'off').status).toBe(0)
    expect(readFileSync(join(home, 'org.yaml'), 'utf-8')).not.toContain('budget')
  })

  it('shows spend and department reports', () => {
    const db = new Database(join(home, 'foreman.db'))
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO agent_usage (id, ts, agent_id, role, department, source, model, input_tokens, total_tokens, cost_usd, cost_estimated)
       VALUES (?, ?, ?, ?, ?, 'telemetry', 'claude-sonnet-4-5', 1000, 1000, ?, 0)`,
    )
    insert.run('u1', now - 1000, 'claude-code', 'cto', 'engineering', 1.25)
    insert.run('u2', now - 900, 'hermes', 'ceo', null, 0.5)
    db.close()

    const usage = run('usage')
    expect(usage.stdout).toContain('Agent spend · today · $1.75')
    expect(usage.stdout).toMatch(/engineering\s+\$1\.25/)
    expect(JSON.parse(run('usage', 'month', '--by', 'agent', '--json').stdout).rows.map((r: { key: string }) => r.key)).toEqual([
      'claude-code',
      'hermes',
    ])
    const report = run('org', 'report', 'engineering', 'today')
    expect(report.status).toBe(0)
    expect(report.stdout).toContain('Engineering · today')
    expect(report.stdout).toContain('Spend $1.25')
    expect(run('org', 'report', 'month').stdout).toContain('Acme · this month')
    expect(run('org', 'report', 'nosuch').stderr).toContain("'nosuch' is not a department")
  })

  it("an agent's `foreman write` can't reach a department paused by its budget; you still can", () => {
    expect(run('org', 'budget', 'marketing', '1', '--daily', '--pause').status).toBe(0)
    const db = new Database(join(home, 'foreman.db'))
    db.prepare(
      `INSERT INTO agent_usage (id, ts, agent_id, role, department, source, input_tokens, total_tokens, cost_usd, cost_estimated)
       VALUES ('u9', ?, 'openclaw', 'cmo', 'marketing', 'telemetry', 1, 1, 5, 0)`,
    ).run(Date.now())
    db.prepare(`INSERT INTO agents (id, display_name, public_key, transport, status, registered_at) VALUES ('openclaw', 'OpenClaw', x'00', 'stdio', 'active', ?)`).run(Date.now())
    db.close()
    const agentEnv = { ...env, FOREMAN_SPAWNED_BY: 'hermes' }
    const fromAgent = spawnSync('node', [FM_BIN, 'write', 'openclaw', 'draft', 'the', 'post'], { env: agentEnv, encoding: 'utf-8' })
    expect(fromAgent.status).toBe(2)
    expect(fromAgent.stderr).toContain('paused by budget')
    expect(run('write', 'openclaw', 'draft', 'the', 'post').status).toBe(0)
  })

  it('prints telemetry setup for agents you start yourself', () => {
    const claude = run('usage', 'env', 'claude-code')
    expect(claude.stdout).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1')
    expect(claude.stdout).toContain('export OTEL_EXPORTER_OTLP_PROTOCOL=http/json')
    // A key of the agent's own, derived from the install key (#657).
    const key = readFileSync(join(home, 'usage.key'), 'utf-8').trim()
    expect(claude.stdout).toContain(`x-foreman-usage-key=${agentUsageKey(key, 'claude-code')}`)
    expect(claude.stdout).not.toContain(`x-foreman-usage-key=${key}\n`)
    expect(run('usage', 'env', 'codex').stdout).toContain('[otel]')
  })
})
