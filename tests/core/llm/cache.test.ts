import { describe, expect, it } from 'vitest'
import { LruCache } from '../../../src/core/llm/cache.js'

describe('LruCache — basic get/set', () => {
  it('returns undefined on missing key', () => {
    const c = new LruCache<number>()
    expect(c.get('nope')).toBeUndefined()
  })

  it('round-trips a value', () => {
    const c = new LruCache<number>()
    c.set('k', 42)
    expect(c.get('k')).toBe(42)
    expect(c.size()).toBe(1)
  })

  it('overwrite updates value + size stays 1', () => {
    const c = new LruCache<number>()
    c.set('k', 1)
    c.set('k', 2)
    expect(c.get('k')).toBe(2)
    expect(c.size()).toBe(1)
  })

  it('delete removes the entry', () => {
    const c = new LruCache<number>()
    c.set('k', 1)
    expect(c.delete('k')).toBe(true)
    expect(c.get('k')).toBeUndefined()
    expect(c.delete('k')).toBe(false)
  })

  it('clear empties the cache', () => {
    const c = new LruCache<number>()
    c.set('a', 1)
    c.set('b', 2)
    c.clear()
    expect(c.size()).toBe(0)
    expect(c.get('a')).toBeUndefined()
  })
})

describe('LruCache — TTL', () => {
  it('expires entries after the default TTL', () => {
    let now = 1_000_000
    const c = new LruCache<number>({ defaultTtlMs: 100, now: () => now })
    c.set('k', 1)
    expect(c.get('k')).toBe(1)
    now += 99
    expect(c.get('k')).toBe(1)
    now += 2 // total 101 — past TTL
    expect(c.get('k')).toBeUndefined()
    expect(c.size()).toBe(0)
  })

  it('per-set TTL overrides the default', () => {
    let now = 1_000_000
    const c = new LruCache<number>({ defaultTtlMs: 100, now: () => now })
    c.set('short', 1, 10)
    c.set('long', 2, 500)
    now += 20
    expect(c.get('short')).toBeUndefined()
    expect(c.get('long')).toBe(2)
  })
})

describe('LruCache — eviction at capacity', () => {
  it('evicts the least-recently-used entry when full', () => {
    const c = new LruCache<number>({ capacity: 3 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    // a is oldest. Touch it to move it to the head, then insert d — b should evict.
    c.get('a')
    c.set('d', 4)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(1)
    expect(c.get('c')).toBe(3)
    expect(c.get('d')).toBe(4)
  })

  it('insertion order without touches → oldest evicted first', () => {
    const c = new LruCache<number>({ capacity: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })

  it('overwrite of existing key does not evict another', () => {
    const c = new LruCache<number>({ capacity: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 11) // overwrite, not insert
    expect(c.size()).toBe(2)
    expect(c.get('a')).toBe(11)
    expect(c.get('b')).toBe(2)
  })
})

describe('LruCache — touch on get', () => {
  it('reading promotes the entry so it survives eviction', () => {
    const c = new LruCache<number>({ capacity: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // touch — a is now newest
    c.set('c', 3) // evicts b (oldest)
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })
})
