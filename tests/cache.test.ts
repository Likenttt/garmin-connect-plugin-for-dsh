import { MemoryCache } from '../src/utils/cache'

describe('MemoryCache', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('should return cached value if not expired', async () => {
    const cache = new MemoryCache(10) // 10 seconds
    const factory = jest.fn().mockResolvedValue('data')

    const v1 = await cache.getOrSet('key', factory)
    expect(v1).toBe('data')
    expect(factory).toHaveBeenCalledTimes(1)

    // Move time forward 5 seconds
    jest.advanceTimersByTime(5000)

    const v2 = await cache.getOrSet('key', factory)
    expect(v2).toBe('data')
    expect(factory).toHaveBeenCalledTimes(1) // Still 1
  })

  it('blocks expired reads on one shared refresh request', async () => {
    const cache = new MemoryCache(10)
    
    // First call
    const factory1 = jest.fn().mockResolvedValue('old-data')
    await cache.getOrSet('key', factory1)
    
    // Move time past TTL
    jest.advanceTimersByTime(11000)

    // Expired callers share one refresh and wait for fresh data.
    let resolveNewData!: (val: string) => void
    const factory2 = jest.fn().mockReturnValue(new Promise(r => { resolveNewData = r }))
    const firstRefresh = cache.getOrSet('key', factory2)
    const secondRefresh = cache.getOrSet('key', factory2)
    let settled = false
    void firstRefresh.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(factory2).toHaveBeenCalledTimes(1)

    resolveNewData('new-data')
    await expect(firstRefresh).resolves.toBe('new-data')
    await expect(secondRefresh).resolves.toBe('new-data')
  })

  it('should respect maxSize and evict oldest', async () => {
    const cache = new MemoryCache(10, 2) // Max size 2
    
    await cache.getOrSet('k1', async () => 'v1')
    await cache.getOrSet('k2', async () => 'v2')
    await cache.getOrSet('k3', async () => 'v3') // Evicts k1

    const factoryK1 = jest.fn().mockResolvedValue('new-v1')
    await cache.getOrSet('k1', factoryK1)
    expect(factoryK1).toHaveBeenCalledTimes(1) // Fetched again
  })

  it('treats an expired refresh as recent for LRU eviction', async () => {
    const cache = new MemoryCache(1, 2)
    await cache.getOrSet('k1', async () => 'v1')
    jest.advanceTimersByTime(500)
    await cache.getOrSet('k2', async () => 'v2')
    jest.advanceTimersByTime(600)

    await cache.getOrSet('k1', async () => 'refreshed-v1')
    await cache.getOrSet('k3', async () => 'v3')

    const k1Factory = jest.fn().mockResolvedValue('unexpected-refetch')
    await expect(cache.getOrSet('k1', k1Factory)).resolves.toBe('refreshed-v1')
    expect(k1Factory).not.toHaveBeenCalled()
  })

  it('does not retain entries when maxSize is zero', async () => {
    const cache = new MemoryCache(10, 0)
    const factory = jest.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second')

    await expect(cache.getOrSet('key', factory)).resolves.toBe('first')
    await expect(cache.getOrSet('key', factory)).resolves.toBe('second')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('does not let an invalidated in-flight request repopulate the cache', async () => {
    const cache = new MemoryCache(10)
    let resolveOld!: (value: string) => void
    const oldRequest = cache.getOrSet(
      'key',
      () => new Promise<string>(resolve => { resolveOld = resolve }),
    )

    cache.invalidate('key')
    resolveOld('old-data')
    await oldRequest

    const freshFactory = jest.fn().mockResolvedValue('fresh-data')
    await expect(cache.getOrSet('key', freshFactory)).resolves.toBe('fresh-data')
    expect(freshFactory).toHaveBeenCalledTimes(1)
  })

})
