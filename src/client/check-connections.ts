export interface ConnectionCheckSummary { total: number; completed: number; cancelled: boolean }
export type ConnectionCheckOutcome<T, R> = { item: T; result: R; error?: never } | { item: T; result?: never; error: unknown }

/** Bounded queue: abort returns immediately and never starts another queued item. */
export function runConnectionChecks<T, R>(options: {
  items: readonly T[]
  signal: AbortSignal
  check(item: T, signal: AbortSignal): Promise<R>
  onStart?(item: T): void
  onResult?(outcome: ConnectionCheckOutcome<T, R>, completed: number): void
}): Promise<ConnectionCheckSummary> {
  const items = [...options.items]
  return new Promise(resolve => {
    let next = 0
    let completed = 0
    let settled = false
    const finish = (cancelled: boolean) => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      resolve({ total: items.length, completed, cancelled })
    }
    const abort = () => finish(true)
    if (options.signal.aborted) { finish(true); return }
    options.signal.addEventListener('abort', abort, { once: true })
    if (!items.length) { finish(false); return }
    async function worker() {
      while (!settled && !options.signal.aborted && next < items.length) {
        const item = items[next++]
        options.onStart?.(item)
        let outcome: ConnectionCheckOutcome<T, R>
        try { outcome = { item, result: await options.check(item, options.signal) } }
        catch (error) { outcome = { item, error } }
        if (settled || options.signal.aborted) return
        completed += 1
        options.onResult?.(outcome, completed)
        if (completed === items.length) finish(false)
      }
    }
    for (let index = 0; index < Math.min(3, items.length); index++) {
      void worker().catch(() => finish(options.signal.aborted))
    }
  })
}
