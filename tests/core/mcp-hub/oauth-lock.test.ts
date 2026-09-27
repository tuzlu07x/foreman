import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OAUTH_HTTP_TIMEOUT_MS } from '../../../src/core/mcp-hub/oauth-http.js'
import { LOCK_STALE_MS, LOCK_WAIT_MS, withLockFile } from '../../../src/core/mcp-hub/oauth-lock.js'

// The cross-process OAuth session lock (#617 review #2): it must never spin,
// never hang on something that isn't a lock file, break stale locks safely,
// and only ever remove its own lock.

describe('withLockFile', () => {
  let dir: string
  let lock: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-oauth-lock-'))
    lock = join(dir, 'session.lock')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A PID that certainly belongs to no running process. */
  function deadPid(): number {
    return spawnSync(process.execPath, ['-e', '']).pid!
  }

  it('is mutually exclusive under contention and cleans up after itself', async () => {
    let inside = 0
    let maxInside = 0
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLockFile(lock, async () => {
          inside++
          maxInside = Math.max(maxInside, inside)
          await delay(5)
          inside--
        }),
      ),
    )
    expect(maxInside).toBe(1)
    expect(existsSync(lock)).toBe(false)
  })

  it('fails fast (no hang, no spin) when a directory sits at the lock path', async () => {
    mkdirSync(lock)
    const started = Date.now()
    await expect(withLockFile(lock, async () => 'x', { waitMs: 5_000 })).rejects.toThrow(/not a regular file/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('fails fast when a dangling symlink sits at the lock path', async () => {
    symlinkSync(join(dir, 'nowhere'), lock)
    const started = Date.now()
    await expect(withLockFile(lock, async () => 'x', { waitMs: 5_000 })).rejects.toThrow(/not a regular file/)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(existsSync(join(dir, 'nowhere'))).toBe(false)
  })

  it('times out behind a live holder, sleeping between attempts', async () => {
    writeFileSync(lock, `${process.pid}:someone-else`)
    const started = Date.now()
    await expect(withLockFile(lock, async () => 'x', { waitMs: 200, staleMs: 10_000 })).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(readFileSync(lock, 'utf-8')).toBe(`${process.pid}:someone-else`)
  })

  it('breaks a lock whose holder process is gone', async () => {
    writeFileSync(lock, `${deadPid()}:crashed`)
    await expect(withLockFile(lock, async () => 'got it', { waitMs: 1_000 })).resolves.toBe('got it')
  })

  it('breaks a lock older than the stale threshold even if its holder PID is alive', async () => {
    writeFileSync(lock, `${process.pid}:hung`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    await expect(withLockFile(lock, async () => 'got it', { waitMs: 1_000, staleMs: 500 })).resolves.toBe('got it')
  })

  it('two waiters breaking the same stale lock still run one at a time', async () => {
    writeFileSync(lock, `${deadPid()}:crashed`)
    let inside = 0
    let maxInside = 0
    const run = (): Promise<void> =>
      withLockFile(
        lock,
        async () => {
          inside++
          maxInside = Math.max(maxInside, inside)
          await delay(30)
          inside--
        },
        { waitMs: 2_000 },
      )
    await Promise.all([run(), run(), run()])
    expect(maxInside).toBe(1)
    expect(readdirLeftovers()).toEqual([])
  })

  it('never removes a lock it no longer owns', async () => {
    await withLockFile(lock, async () => {
      // Someone judged us stale and took over.
      writeFileSync(lock, `${process.pid}:new-owner`)
    })
    expect(readFileSync(lock, 'utf-8')).toBe(`${process.pid}:new-owner`)
  })

  it('keeps the stale threshold below the wait, and above one OAuth request', () => {
    // A waiter outlives a hung holder; a holder doing one token request is
    // never judged stale mid-request.
    expect(LOCK_STALE_MS).toBeLessThan(LOCK_WAIT_MS)
    expect(OAUTH_HTTP_TIMEOUT_MS).toBeLessThan(LOCK_STALE_MS)
  })

  function readdirLeftovers(): string[] {
    return (spawnSync('ls', ['-A', dir], { encoding: 'utf-8' }).stdout ?? '').split('\n').filter(Boolean)
  }
})
