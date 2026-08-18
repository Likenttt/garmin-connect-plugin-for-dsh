/**
 * An in-memory cache with TTL, LRU eviction, and Stale-While-Revalidate (SWR) support.
 *
 * Purpose: Garmin's unofficial API is aggressive with rate-limiting and can be slow.
 * This cache prevents the AI agent from hammering the API when it retries,
 * and uses SWR to return stale data immediately while fetching fresh data in the background.
 */
export class MemoryCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>()
  private pending = new Map<string, Promise<unknown>>()
  private ttlMs: number
  private maxSize: number

  constructor(ttlSeconds: number, maxSize = 100) {
    this.ttlMs = ttlSeconds * 1000
    this.maxSize = maxSize
  }

  /** Return a cached value, or call `factory`, cache & return the result. */
  async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) {
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
      const fetchPromise = factory()
        .then((value) => {
          this.set(key, value)
          return value
        })
        .finally(() => {
          this.pending.delete(key)
        })
      this.pending.set(key, fetchPromise)
    }

    if (entry) {
      // 3. Stale-While-Revalidate: Return stale immediately while fetching in background
      this.refreshLRU(key, entry)
      // Note: we swallow background fetch errors here to avoid unhandled rejections if the
      // stale return is already resolved. The user just gets stale data until next time.
      this.pending.get(key)?.catch(() => {})
      return entry.value as T
    }

    // 4. No stale data, must block and wait for the fetch
    return this.pending.get(key) as Promise<T>
  }

  private set(key: string, value: unknown): void {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      // Evict oldest (Map iterates in insertion order)
      const oldestKey = this.store.keys().next().value
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey)
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  private refreshLRU(key: string, entry: { value: unknown; expiresAt: number }): void {
    // Delete and re-insert to move to end of iteration order (most recently used)
    this.store.delete(key)
    this.store.set(key, entry)
  }

  /** Manually invalidate a single key. */
  invalidate(key: string): void {
    this.store.delete(key)
    this.pending.delete(key)
  }

  /** Drop everything. */
  clear(): void {
    this.store.clear()
    this.pending.clear()
  }
}
