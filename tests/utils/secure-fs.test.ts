import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensurePrivateDir } from '../../src/utils/secure-fs.js'

const mode = (p: string): number => statSync(p).mode & 0o777

describe.skipIf(process.platform === 'win32')('ensurePrivateDir', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'foreman-securefs-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a new directory owner-only', () => {
    const dir = join(root, 'custom-home')
    ensurePrivateDir(dir)
    expect(mode(dir)).toBe(0o700)
  })

  it("tightens an existing directory that is Foreman's own", () => {
    for (const name of ['foreman', '.foreman-dev']) {
      const dir = join(root, name)
      mkdirSync(dir)
      chmodSync(dir, 0o755)
      ensurePrivateDir(dir)
      expect(mode(dir)).toBe(0o700)
    }
  })

  it('leaves an existing shared directory (FOREMAN_HOME=$PWD) alone', () => {
    const dir = join(root, 'project')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    ensurePrivateDir(dir)
    expect(mode(dir)).toBe(0o755)
  })
})
