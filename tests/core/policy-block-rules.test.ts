import type Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { DEFAULT_POLICY_YAML } from '../../src/cli/policy-template.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

// #656 (D): a block rule (Telegram's block button) is kept in one place,
// policy.yaml, and removing it there or with `policy remembered remove`
// removes it.

describe('block rules have one home', () => {
  let db: ForemanDb
  let sqlite: Database.Database
  let dir: string
  let path: string
  let engine: PolicyEngine
  const block = (approvalId: string) =>
    engine.addPredicateRule({
      sourceAgent: 'hermes',
      target: 'tool:read_file',
      predicate: { pathMatch: ['\\.env$'] },
      approvalId,
      reason: 'secret_path',
      policyYamlPath: path,
    })
  const readEnv = () => engine.evaluate({ sourceAgent: 'hermes', targetTool: 'read_file', args: { path: '/app/.env' } })
  const copies = () => engine.list().filter((r) => (r.conditions ?? '').includes('"approvalId"'))

  beforeEach(() => {
    ;({ db, sqlite } = createInMemoryDb())
    dir = mkdtempSync(join(tmpdir(), 'foreman-block-'))
    path = join(dir, 'policy.yaml')
    writeFileSync(path, DEFAULT_POLICY_YAML)
    engine = new PolicyEngine(db, new EventBus<ForemanEventMap>())
    engine.loadFromYaml(path)
  })
  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lands in rules: of the default template (which ends with another block), once', () => {
    const id = block('appr-1')
    const doc = parseYaml(readFileSync(path, 'utf-8')) as { rules: Array<{ source: string }>; responsibility_policies: unknown[] }
    expect(doc.rules.at(-1)!.source).toBe('hermes')
    expect(doc.responsibility_policies).toHaveLength(4)
    expect(readEnv()).toMatchObject({ decision: 'deny', matchedRuleId: id })
    engine.loadFromYaml(path)
    expect(copies()).toHaveLength(1)
    expect(engine.listRemembered().map((r) => r.id)).toContain(id)
  })

  it('deleting it from policy.yaml removes it', () => {
    block('appr-2')
    const doc = parseYaml(readFileSync(path, 'utf-8')) as { rules: unknown[] }
    doc.rules.pop()
    writeFileSync(path, `rules: ${JSON.stringify(doc.rules)}\n`)
    engine.loadFromYaml(path)
    expect(copies()).toHaveLength(0)
    expect(readEnv().decision).not.toBe('deny')
  })

  it('`policy remembered remove` takes it out of the file too', () => {
    const id = block('appr-3')
    engine.removeRemembered(id, { policyYamlPath: path })
    expect(readFileSync(path, 'utf-8')).not.toContain('appr-3')
    expect(copies()).toHaveLength(0)
    engine.loadFromYaml(path)
    expect(readEnv().decision).not.toBe('deny')
  })

  it("an older install's database copy goes once the file has the rule, so deleting the block removes it", () => {
    // Before #656: a database row and a text block appended to the file.
    sqlite.prepare(
      "INSERT INTO policies (source_agent, target, effect, conditions, created_at, created_by, enabled) VALUES ('hermes','tool:read_file','deny',?,1,'remember-action',1)",
    ).run(JSON.stringify({ pathMatch: ['\\.env$'], source: { kind: 'approval', approvalId: 'old-1', addedAt: 1 } }))
    writeFileSync(
      path,
      'rules:\n# === Foreman approval-injected rule ===\n# Added from approval old-1 at 2026-01-01T00:00:00.000Z\n  - source: hermes\n    target: tool:read_file\n    effect: deny\n    conditions:\n      pathMatch:\n        - "\\\\.env$"\n',
    )
    engine.loadFromYaml(path)
    expect(engine.list().filter((r) => r.createdBy === 'remember-action')).toHaveLength(0)
    expect(readEnv().decision).toBe('deny')
    writeFileSync(path, 'rules: []\n')
    engine.loadFromYaml(path)
    expect(readEnv().decision).not.toBe('deny')
  })

  it('a policy.yaml that is already broken is left alone; the rule is kept in the database', () => {
    writeFileSync(path, '- broken: [\n')
    const id = block('appr-4')
    expect(readFileSync(path, 'utf-8')).toBe('- broken: [\n')
    expect(engine.list().find((r) => r.id === id)?.createdBy).toBe('remember-action')
    expect(readEnv().decision).toBe('deny')
  })
})
