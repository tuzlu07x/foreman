import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { NotInitialisedError, startForeman } from '../../src/cli/start.js'

describe('foreman init', () => {
  let tmpHome: string
  let savedHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-cli-'))
    savedHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmpHome
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates root, identity, policy, and database on first run', () => {
    const result = runInit()
    expect(existsSync(result.paths.root)).toBe(true)
    expect(existsSync(result.paths.identityPath)).toBe(true)
    expect(existsSync(result.paths.policyPath)).toBe(true)
    expect(existsSync(result.paths.dbPath)).toBe(true)
    expect(result.identityWasNew).toBe(true)
    expect(result.policyWasNew).toBe(true)
  })

  it('writes a non-empty policy template', () => {
    runInit()
    const policyText = readFileSync(join(tmpHome, 'policy.yaml'), 'utf-8')
    expect(policyText).toContain('# Foreman policy file')
    expect(policyText.length).toBeGreaterThan(50)
  })

  it.runIf(process.platform !== 'win32')(
    'persists identity.key with 0600 perms',
    () => {
      runInit()
      const stat = statSync(join(tmpHome, 'identity.key'))
      expect(stat.mode & 0o777).toBe(0o600)
    },
  )

  it('is idempotent — second call keeps identity and policy intact', () => {
    const first = runInit()
    const policyBefore = readFileSync(first.paths.policyPath)
    const identityBefore = readFileSync(first.paths.identityPath)
    const second = runInit()
    expect(second.identityWasNew).toBe(false)
    expect(second.policyWasNew).toBe(false)
    expect(readFileSync(second.paths.policyPath).equals(policyBefore)).toBe(true)
    expect(readFileSync(second.paths.identityPath).equals(identityBefore)).toBe(true)
    expect(second.publicKey.equals(first.publicKey)).toBe(true)
  })
})

describe('foreman start', () => {
  let tmpHome: string
  let savedHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-start-'))
    savedHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmpHome
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it("throws NotInitialisedError when ~/.foreman/ is missing", () => {
    rmSync(tmpHome, { recursive: true, force: true })
    expect(() => startForeman()).toThrow(NotInitialisedError)
  })

  it('boots services after init and exposes registry + audit', async () => {
    runInit()
    const started = startForeman()
    expect(started.registry.list()).toEqual([])
    expect(started.publicKey).toHaveLength(32)
    await started.shutdown()
  })
})
