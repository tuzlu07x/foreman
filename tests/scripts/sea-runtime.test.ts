import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import runtime from '../../scripts/sea-runtime.cjs'
import type { Payload } from '../../scripts/sea-runtime.cjs'

// The start-up code of the standalone binary (scripts/build-binaries.mjs
// inlines it into the SEA main script). It decides what an invocation
// means and writes the binary's files out to a verified runtime dir.

function payloadOf(files: Record<string, string>): Payload {
  const list = Object.entries(files).map(([path, text]) => ({
    path,
    sha256: runtime.sha256(Buffer.from(text)),
    mode: 0o644,
    data: Buffer.from(text).toString('base64'),
  }))
  return { version: '9.9.9', digest: runtime.sha256(list.map((f) => f.sha256).join('')), files: list }
}

describe('sea runtime', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-sea-runtime-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('classifyInvocation', () => {
    let exe: string

    beforeEach(() => {
      exe = join(dir, 'foreman')
      writeFileSync(exe, 'binary', { mode: 0o755 })
    })

    it('runs the CLI with the binary as the script path', () => {
      expect(runtime.classifyInvocation([exe, 'foreman', 'init', '--force'], exe)).toEqual({
        mode: 'cli',
        argv: [exe, exe, 'init', '--force'],
      })
    })

    it('drops the binary when the CLI re-runs itself, through a symlink too', () => {
      const link = join(dir, 'link')
      symlinkSync(exe, link)
      expect(runtime.classifyInvocation([exe, exe, exe, 'mcp-stdio'], exe).argv).toEqual([exe, exe, 'mcp-stdio'])
      expect(runtime.classifyInvocation([exe, 'foreman', link, 'start'], exe).argv).toEqual([exe, exe, 'start'])
    })

    it('runs a script whose #! line names this binary, like node would', () => {
      const stub = join(dir, 'claude')
      writeFileSync(stub, `#!${exe}\nconsole.log('hi')\n`, { mode: 0o755 })
      expect(runtime.classifyInvocation([exe, exe, stub, '--print', 'x'], exe)).toEqual({
        mode: 'script',
        argv: [exe, stub, '--print', 'x'],
      })
    })

    it('treats other paths as ordinary arguments', () => {
      const other = join(dir, 'other')
      writeFileSync(other, '#!/usr/bin/env node\n', { mode: 0o755 })
      expect(runtime.classifyInvocation([exe, exe, other], exe)).toEqual({ mode: 'cli', argv: [exe, exe, other] })
      expect(runtime.classifyInvocation([exe, exe, join(dir, 'missing')], exe).mode).toBe('cli')
    })
  })

  describe('runtimeRoot', () => {
    it("follows Foreman's cache dir", () => {
      expect(runtime.runtimeRoot({ FOREMAN_HOME: '/fh' }, 'linux', '/u')).toBe('/fh/cache/runtime')
      expect(runtime.runtimeRoot({}, 'darwin', '/u')).toBe('/u/Library/Caches/foreman/runtime')
      expect(runtime.runtimeRoot({ XDG_CACHE_HOME: '/x' }, 'linux', '/u')).toBe('/x/foreman/runtime')
      expect(runtime.runtimeRoot({}, 'linux', '/u')).toBe('/u/.cache/foreman/runtime')
    })
  })

  describe('ensureRuntimeDir', () => {
    const payload = payloadOf({ 'lib/addon.node': 'native', 'db/migrations/0001.sql': 'create table t (x);' })
    const env = (): NodeJS.ProcessEnv => ({ FOREMAN_HOME: join(dir, 'home') })

    it('writes the files once into a private dir and reuses it', () => {
      const rt = runtime.ensureRuntimeDir(payload, env())
      expect(rt).toBe(join(dir, 'home', 'cache', 'runtime', `9.9.9-${payload.digest.slice(0, 16)}`))
      expect(readFileSync(join(rt, 'lib/addon.node'), 'utf-8')).toBe('native')
      expect(statSync(rt).mode & 0o077).toBe(0)
      const ino = statSync(join(rt, 'lib/addon.node')).ino
      expect(runtime.ensureRuntimeDir(payload, env())).toBe(rt)
      expect(statSync(join(rt, 'lib/addon.node')).ino).toBe(ino)
    })

    it('rewrites a changed file', () => {
      const rt = runtime.ensureRuntimeDir(payload, env())
      writeFileSync(join(rt, 'lib/addon.node'), 'evil')
      expect(runtime.verifyDir(rt, payload.files)).toBe(false)
      expect(runtime.ensureRuntimeDir(payload, env())).toBe(rt)
      expect(readFileSync(join(rt, 'lib/addon.node'), 'utf-8')).toBe('native')
    })

    it('rewrites a file swapped for a symlink, even to identical bytes', () => {
      const rt = runtime.ensureRuntimeDir(payload, env())
      const elsewhere = join(dir, 'elsewhere.node')
      writeFileSync(elsewhere, 'native')
      rmSync(join(rt, 'lib/addon.node'))
      symlinkSync(elsewhere, join(rt, 'lib/addon.node'))
      expect(runtime.verifyDir(rt, payload.files)).toBe(false)
      runtime.ensureRuntimeDir(payload, env())
      expect(runtime.verifyDir(rt, payload.files)).toBe(true)
    })

    it('does not trust a dir others can write to', () => {
      const rt = runtime.ensureRuntimeDir(payload, env())
      chmodSync(rt, 0o777)
      expect(runtime.verifyDir(rt, payload.files)).toBe(false)
      runtime.ensureRuntimeDir(payload, env())
      expect(statSync(rt).mode & 0o077).toBe(0)
    })

    it('falls back to a private temp dir when the cache dir is unusable', () => {
      const blocker = join(dir, 'not-a-dir')
      writeFileSync(blocker, '')
      const rt = runtime.ensureRuntimeDir(payload, { FOREMAN_HOME: blocker })
      expect(rt.startsWith(join(tmpdir(), 'foreman-runtime-'))).toBe(true)
      expect(runtime.verifyDir(rt, payload.files)).toBe(true)
      rmSync(rt, { recursive: true, force: true })
    })

    it('leaves no temp dirs behind', () => {
      mkdirSync(join(dir, 'home'))
      runtime.ensureRuntimeDir(payload, env())
      const root = join(dir, 'home', 'cache', 'runtime')
      expect(existsSync(root)).toBe(true)
      expect(readdirSync(root)).toEqual([`9.9.9-${payload.digest.slice(0, 16)}`])
    })
  })
})
