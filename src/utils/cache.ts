/**
 * A dead-simple in-memory TTL cache.
 *
 * Purpose: Garmin's unofficial API is aggressive with rate-limiting.
 * This cache prevents the AI agent from hammering the API when it retries
 * or re-plans within a single conversation turn.
 */
export class MemoryCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>()
  private ttlMs: number

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000
  }

  /** Return a cached value, or call `factory`, cache & return the result. */
  async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) {
      // Cache disabled
      return factory()
    }

    const entry = this.store.get(key)
    if (entry && Date.now() < entry.expiresAt) {
      return entry.value as T
    }

    const value = await factory()
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    return value
  }

  /** Manually invalidate a single key. */
  invalidate(key: string): void {
    this.store.delete(key)
  }

  /** Drop everything. */
  clear(): void {
    this.store.clear()
  }
}
