import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMcpHub } from '../../../src/core/doctor.js'
import { closeDb } from '../../../src/db/client.js'

describe('doctor: mcp_hub check', () => {
  let home: string
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FOREMAN_HOME
    home = mkdtempSync(join(tmpdir(), 'foreman-doctor-hub-'))
    process.env.FOREMAN_HOME = home
  })
  afterEach(() => {
    closeDb()
    if (prev === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })

  it('is ok when the hub is not configured', () => {
    expect(checkMcpHub().status).toBe('ok')
  })

  it('fails on an invalid mcp.yaml', () => {
    writeFileSync(join(home, 'mcp.yaml'), 'servers:\n  Bad_Name:\n    command: x\n')
    expect(checkMcpHub().status).toBe('fail')
  })

  it('warns about missing secrets for enabled servers', () => {
    writeFileSync(
      join(home, 'mcp.yaml'),
      'servers:\n  gh:\n    url: https://api.githubcopilot.com/mcp/\n    headers:\n      Authorization: "Bearer ${secret:github-pat}"\n',
    )
    const result = checkMcpHub()
    expect(result.status).toBe('warn')
    expect(result.message).toContain('gh: github-pat')
  })
})
