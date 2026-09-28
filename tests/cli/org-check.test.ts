import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const FM_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/cli/index.js')

// Two departments; alpha and gamma head them, beta and delta work in them.
const ORG_YAML = `version: 1
company: "Test Co"
delegation:
  cross_department: via_heads
departments:
  eng: { name: Engineering, head: lead }
  mkt: { name: Marketing, head: cmo }
roles:
  lead: { title: Lead, agent: alpha, department: eng, reports_to: human }
  dev: { title: Dev, agent: beta, department: eng, reports_to: lead }
  cmo: { title: CMO, agent: gamma, department: mkt, reports_to: human }
  writer: { title: Writer, agent: delta, department: mkt, reports_to: cmo }
`

// QA: `foreman org check` didn't say which side was missing, took only
// agent ids, exited 0 on a typo, dropped the chart's own reason for a
// block, gave no next step, and ignored policy.yaml's can_call /
// cannot_call.
describe('foreman org check', () => {
  let dir: string
  let fh: string
  let env: NodeJS.ProcessEnv
  const check = (from: string, to: string) =>
    spawnSync('node', [FM_BIN, 'org', 'check', from, to], { env, encoding: 'utf-8' })
  const writePolicy = (text: string) => writeFileSync(join(fh, 'policy.yaml'), text)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-org-check-'))
    fh = join(dir, 'fh')
    env = { PATH: process.env.PATH, HOME: join(dir, 'home'), FOREMAN_HOME: fh, TMPDIR: dir, NO_COLOR: '1', FOREMAN_NO_UPDATE_CHECK: '1' }
    expect(spawnSync('node', [FM_BIN, 'init'], { env, encoding: 'utf-8' }).status).toBe(0)
    writeFileSync(join(fh, 'org.yaml'), ORG_YAML)
    writePolicy('')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('names the missing side and exits 1', () => {
    const one = check('beta', 'ghost')
    expect(one.status).toBe(1)
    expect(one.stderr).toContain("<to> 'ghost' is not an agent or role in org.yaml")
    expect(one.stderr).not.toContain('beta')
    const both = check('nobody', 'ghost')
    expect(both.status).toBe(1)
    expect(both.stderr).toContain("<from> 'nobody' and <to> 'ghost' are not agents or roles")
  })

  it('accepts role ids as well as agent ids', () => {
    const byRole = check('dev', 'lead')
    expect(byRole.status).toBe(0)
    expect(byRole.stdout).toContain('dev is filled by beta')
    expect(byRole.stdout).toContain('allowed — dev reports to lead')
    expect(check('beta', 'lead').stdout).toContain('allowed — dev reports to lead')
  })

  it('keeps the chart’s reason for a block and suggests the route', () => {
    const res = check('beta', 'gamma') // dev (eng) → cmo (mkt)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('blocked — dev → cmo is outside the reporting chain in org.yaml: cross-department work must go through department heads')
    expect(res.stdout).toContain("next: hand it to lead (alpha), dev's manager, who can assign it to cmo")
    // A head reaching into another department goes through that head.
    const head = check('lead', 'writer')
    expect(head.status).toBe(1)
    expect(head.stdout).toContain('next: hand it to cmo (gamma), head of Marketing, who can assign it to writer')
  })

  it('says when no policy.yaml rule applies and org.yaml decides', () => {
    const res = check('alpha', 'beta')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('allowed — lead manages dev')
    expect(res.stdout).toContain('no policy.yaml rule for this pair, so org.yaml decides')
  })

  it('checks policy.yaml first: cannot_call blocks what the chart allows', () => {
    writePolicy('agents:\n  alpha:\n    cannot_call:\n      beta: [write]\n')
    const res = check('lead', 'dev')
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/blocked — policy\.yaml decides \(alpha → beta:write deny, rule #\d+\)/)
  })

  it('a can_call list that leaves write out blocks the hand-off', () => {
    writePolicy('agents:\n  alpha:\n    can_call:\n      beta: [read_file]\n')
    const res = check('alpha', 'beta')
    expect(res.status).toBe(1)
    expect(res.stdout).toContain("policy.yaml decides (agents.alpha.can_call.beta doesn't list write)")
  })

  it('a can_call allow does not lift a block from the chart, and says so', () => {
    writePolicy('agents:\n  beta:\n    can_call:\n      gamma: [write]\n')
    const res = check('beta', 'gamma')
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('blocked — dev → cmo is outside the reporting chain')
    expect(res.stdout).toContain("policy.yaml allows it (beta → gamma:write allow, rule #")
    expect(res.stdout).toContain("doesn't lift a block from the org chart")
  })

  it('reports an ask rule on a hand-off the chart allows', () => {
    writePolicy('rules:\n  - source: alpha\n    target: "gamma:write"\n    effect: ask\n')
    const res = check('lead', 'cmo')
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/ask — org\.yaml allows it \(department heads coordinate directly\), and policy\.yaml sends it to you for approval \(alpha → gamma:write ask, rule #\d+\)/)
  })

  it('stops on a policy.yaml that does not load', () => {
    writePolicy('agents: [not, a, map\n')
    const res = check('alpha', 'beta')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('policy.yaml failed to parse')
    expect(res.stdout).not.toContain('allowed')
  })
})
