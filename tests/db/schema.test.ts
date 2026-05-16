import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations')

function applyAllMigrations(db: Database.Database): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')
    // Drizzle uses `--> statement-breakpoint` between statements.
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const stmt of statements) db.exec(stmt)
  }
  return files
}

describe('migrations', () => {
  it('apply cleanly to a fresh in-memory database', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const files = applyAllMigrations(db)
    expect(files).toContain('0000_sleepy_thunderbolts.sql')
    expect(files).toContain('0001_fts5_requests.sql')
    db.close()
  })

  it('create every table the v0.1 design calls for', () => {
    const db = new Database(':memory:')
    applyAllMigrations(db)
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`,
      )
      .all() as { name: string }[]
    const names = rows.map((r) => r.name)
    for (const t of [
      'agents',
      'audit_events',
      'policies',
      'requests',
      'requests_fts',
      'sessions',
    ]) {
      expect(names, `table ${t} should exist`).toContain(t)
    }
    db.close()
  })

  it('create the three lookup indexes the design requires', () => {
    const db = new Database(':memory:')
    applyAllMigrations(db)
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[]
    const names = rows.map((r) => r.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'policies_lookup_idx',
        'requests_source_created_idx',
        'requests_decision_created_idx',
      ]),
    )
    db.close()
  })

  it('keep requests_fts in sync with requests via triggers', () => {
    const db = new Database(':memory:')
    applyAllMigrations(db)

    const insert = db.prepare(
      `INSERT INTO requests
        (id, source_agent, args, risk_score, decision, created_at)
       VALUES (?, 'hermes', ?, 10, 'allowed', ?)`,
    )
    insert.run('r1', JSON.stringify({ path: 'src/auth.ts' }), Date.now())
    insert.run('r2', JSON.stringify({ path: '.env' }), Date.now())

    const hits = db
      .prepare(
        `SELECT request_id FROM requests_fts WHERE requests_fts MATCH ? ORDER BY request_id`,
      )
      .all('env') as { request_id: string }[]
    expect(hits.map((h) => h.request_id)).toEqual(['r2'])

    db.prepare(`UPDATE requests SET result = ? WHERE id = ?`).run(
      JSON.stringify({ ok: true, secret_revealed: 'API_KEY' }),
      'r1',
    )
    const apiHits = db
      .prepare(
        `SELECT request_id FROM requests_fts WHERE requests_fts MATCH ?`,
      )
      .all('API_KEY') as { request_id: string }[]
    expect(apiHits.map((h) => h.request_id)).toContain('r1')

    db.prepare(`DELETE FROM requests WHERE id = ?`).run('r2')
    const remaining = db
      .prepare(
        `SELECT request_id FROM requests_fts WHERE requests_fts MATCH ?`,
      )
      .all('env') as { request_id: string }[]
    expect(remaining).toEqual([])

    db.close()
  })

  it('indexes source_agent, target_tool, decision so log search can find them (#217)', () => {
    const db = new Database(':memory:')
    applyAllMigrations(db)
    db.prepare(
      `INSERT INTO requests
         (id, source_agent, target_agent, target_tool, args, risk_score, decision, risk_reasons, created_at)
       VALUES
         ('rA', 'claude-code', 'foreman', 'secrets/get', '{}', 60, 'denied', 'secret_file outbound', ?)`,
    ).run(Date.now())

    const search = (term: string): string[] =>
      (
        db
          .prepare(`SELECT request_id FROM requests_fts WHERE requests_fts MATCH ?`)
          .all(term) as { request_id: string }[]
      ).map((h) => h.request_id)

    // The user types things they saw in `log tail` — agent ids, tool names,
    // the decision keyword. All three must match (porter tokenizer splits on
    // '-' and '/' so 'claude' and 'code' / 'secrets' and 'get' are tokens).
    expect(search('claude')).toContain('rA')
    expect(search('code')).toContain('rA')
    expect(search('secrets')).toContain('rA')
    expect(search('denied')).toContain('rA')
    expect(search('outbound')).toContain('rA')

    db.close()
  })
})
