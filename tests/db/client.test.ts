import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, createInMemoryDb, getDb } from '../../src/db/client.js'
import { agents } from '../../src/db/schema.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('db client — createInMemoryDb', () => {
  it('returns a migrated DB that can insert and read one agent row', () => {
    const { db, sqlite } = createInMemoryDb()
    db.insert(agents)
      .values({
        id: 'hermes',
        displayName: 'Hermes Personal Assistant',
        publicKey: Buffer.from('fake-pubkey'),
        transport: 'stdio',
        registeredAt: Date.now(),
        status: 'active',
      })
      .run()
    const rows = db.select().from(agents).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('hermes')
    expect(rows[0]?.transport).toBe('stdio')
    sqlite.close()
  })
})

describe('db client — getDb against FOREMAN_HOME', () => {
  let tmpHome: string
  let savedHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-test-'))
    savedHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmpHome
  })

  afterEach(() => {
    closeDb()
    if (savedHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates the DB file, applies migrations, and returns the same singleton', () => {
    const db1 = getDb()
    db1.insert(agents)
      .values({
        id: 'claude-code',
        displayName: 'Claude Code',
        publicKey: Buffer.from('fake-pubkey-2'),
        transport: 'stdio',
        registeredAt: Date.now(),
        status: 'active',
      })
      .run()
    const db2 = getDb()
    expect(db2).toBe(db1)
    const rows = db2.select().from(agents).all()
    expect(rows.map((r) => r.id)).toEqual(['claude-code'])
  })
})
