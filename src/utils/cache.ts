/**
 * An in-memory cache with TTL, LRU eviction, and single-flight refreshes.
 *
 * Purpose: Garmin's unofficial API is aggressive with rate-limiting and can be slow.
 * This cache prevents the AI agent from hammering the API when it retries,
 * Expired entries block on one shared refresh so callers never receive unmarked stale data.
 */
interface CacheEntry {
  value: unknown
  expiresAt: number
}

export class MemoryCache {
  private store = new Map<string, CacheEntry>()
  private pending = new Map<string, Promise<unknown>>()
  private ttlMs: number
  private maxSize: number

  constructor(ttlSeconds: number, maxSize = 100) {
    this.ttlMs = ttlSeconds * 1000
    this.maxSize = maxSize
  }

  /** Return a cached value, or call `factory`, cache & return the result. */
  async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0 || this.maxSize <= 0) {
      // Cache disabled
      return factory()
    }

    const entry = this.store.get(key)
    const isExpired = !entry || Date.now() >= entry.expiresAt

    if (entry && !isExpired) {
      // 1. Fresh data, just return it
      this.refreshLRU(key, entry)
      return entry.value as T
    }

    // 2. Data is stale or absent. We need to fetch.
    // Ensure only one background fetch per key.
    if (!this.pending.has(key)) {
      let fetchPromise: Promise<T>
      fetchPromise = factory()
        .then((value) => {
          // Invalidating a key detaches its old request. Only the currently
          // registered request may populate the cache.
          if (this.pending.get(key) === fetchPromise) this.set(key, value)
          return value
        })
        .finally(() => {
          if (this.pending.get(key) === fetchPromise) this.pending.delete(key)
        })
      this.pending.set(key, fetchPromise)
    }

    // Expired and missing entries both wait for the shared refresh.
    return this.pending.get(key) as Promise<T>
  }

  private set(key: string, value: unknown): void {
    // A refreshed existing key is the most-recently used entry too.
    this.store.delete(key)
    if (this.store.size >= this.maxSize) {
      // Evict oldest (Map iterates in insertion order)
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }
    const now = Date.now()
    this.store.set(key, {
      value,
      expiresAt: now + this.ttlMs,
    })
  }

  private refreshLRU(key: string, entry: CacheEntry): void {
    // Delete and re-insert to move to end of iteration order (most recently used)
    this.store.delete(key)
    this.store.set(key, entry)
  }

  /** Manually invalidate a single key. */
  invalidate(key: string): void {
    this.store.delete(key)
    this.pending.delete(key)
  }

  /** Invalidate all keys that start with the given prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(prefix)) this.pending.delete(key)
    }
  }

  /** Drop everything. */
  clear(): void {
    this.store.clear()
    this.pending.clear()
  }
}
