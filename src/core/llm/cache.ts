// =============================================================================
// LRU cache with TTL (#231 / C8)
// =============================================================================
//
// Verification calls for identical patterns within a short window (5 min)
// reuse the prior LLM response. Cache key = source.target.tool + canonical
// args + sorted factor ids. Identical-pattern bursts (loop, ping-pong)
// don't burn LLM credits.

export interface LruEntry<V> {
  value: V
  expiresAt: number
  /** Linked-list pointer for LRU bookkeeping. */
  prev: LruEntry<V> | null
  next: LruEntry<V> | null
  key: string
}

export interface LruCacheOptions {
  /** Max entries. Oldest evicted when full. */
  capacity?: number
  /** Default TTL in ms. Per-call set() can override. */
  defaultTtlMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export class LruCache<V> {
  private readonly capacity: number
  private readonly defaultTtlMs: number
  private readonly now: () => number
  private readonly map = new Map<string, LruEntry<V>>()
  private head: LruEntry<V> | null = null // newest
  private tail: LruEntry<V> | null = null // oldest

  constructor(opts: LruCacheOptions = {}) {
    this.capacity = opts.capacity ?? 256
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  size(): number {
    return this.map.size
  }

  /** Return the cached value if present + unexpired. Touches LRU order. */
  get(key: string): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.removeEntry(entry)
      return undefined
    }
    this.touch(entry)
    return entry.value
  }

  /** Insert or overwrite. Evicts the oldest entry when full. */
  set(key: string, value: V, ttlMs?: number): void {
    const existing = this.map.get(key)
    if (existing) {
      existing.value = value
      existing.expiresAt = this.now() + (ttlMs ?? this.defaultTtlMs)
      this.touch(existing)
      return
    }
    if (this.map.size >= this.capacity && this.tail) {
      this.removeEntry(this.tail)
    }
    const entry: LruEntry<V> = {
      key,
      value,
      expiresAt: this.now() + (ttlMs ?? this.defaultTtlMs),
      prev: null,
      next: this.head,
    }
    if (this.head) this.head.prev = entry
    this.head = entry
    if (!this.tail) this.tail = entry
    this.map.set(key, entry)
  }

  /** Remove a specific key. Returns true if it was present. */
  delete(key: string): boolean {
    const entry = this.map.get(key)
    if (!entry) return false
    this.removeEntry(entry)
    return true
  }

  /** Drop everything. */
  clear(): void {
    this.map.clear()
    this.head = null
    this.tail = null
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private touch(entry: LruEntry<V>): void {
    if (this.head === entry) return
    // Detach
    if (entry.prev) entry.prev.next = entry.next
    if (entry.next) entry.next.prev = entry.prev
    if (this.tail === entry) this.tail = entry.prev
    // Push to head
    entry.prev = null
    entry.next = this.head
    if (this.head) this.head.prev = entry
    this.head = entry
  }

  private removeEntry(entry: LruEntry<V>): void {
    if (entry.prev) entry.prev.next = entry.next
    else this.head = entry.next
    if (entry.next) entry.next.prev = entry.prev
    else this.tail = entry.prev
    this.map.delete(entry.key)
  }
}
