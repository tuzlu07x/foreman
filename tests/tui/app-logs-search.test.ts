import { afterEach, describe, expect, it } from 'vitest'
import { requests } from '../../src/db/schema.js'
import { mountApp, type MountedApp } from '../support/tui-app.js'

// QA #657 H3 — every keystroke in the Logs search runs a query; `qa-`
// was FTS5 syntax and the error took the whole TUI (and any approval
// waiting in it) down.
describe('TUI Logs search', () => {
  let m: MountedApp
  afterEach(() => m.unmount())

  it('filters by hyphenated agent ids as you type, without crashing', async () => {
    m = await mountApp(({ db }) => {
      const now = Date.now()
      db.insert(requests)
        .values({ id: 'r1', sourceAgent: 'qa-bot', targetTool: 'read_file', args: '{"path":"a.md"}', riskScore: 0, decision: 'allowed', decidedBy: 'auto', createdAt: now })
        .run()
      db.insert(requests)
        .values({ id: 'r2', sourceAgent: 'hermes', targetTool: 'list_files', args: '{"path":"."}', riskScore: 0, decision: 'allowed', decidedBy: 'auto', createdAt: now - 1 })
        .run()
      return {}
    })
    await m.press('l')
    await m.press('/')
    for (const ch of 'qa-b') await m.press(ch, 30)
    const frame = m.frame()
    expect(frame).toContain('qa-b')
    expect(frame).toContain('1 match')
    expect(frame).toContain('qa-bot')
    expect(frame).not.toContain('list_files')
    expect(frame).not.toContain('invalid search')
    for (const ch of ' AND *"') await m.press(ch, 30)
    expect(m.frame()).toContain('Logs')
  })
})
