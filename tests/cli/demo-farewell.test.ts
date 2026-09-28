import { describe, expect, it } from 'vitest'
import { demoFarewell } from '../../src/cli/demo/demo-cli.js'

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

// QA #657 L12 — the demo ended with "Ready for the real thing? foreman
// setup", which fails with "not initialised" on a fresh machine.
describe('demo farewell', () => {
  it('points at a command that works on a fresh box', () => {
    const line = plain(demoFarewell(null))
    expect(line).toContain('foreman start')
    expect(line).not.toContain('foreman setup')
  })

  it('says where a kept demo is', () => {
    expect(plain(demoFarewell({ root: '/tmp/d', home: '/tmp/d/home' }))).toBe('✓ demo kept at /tmp/d (FOREMAN_HOME=/tmp/d/home)')
  })
})
