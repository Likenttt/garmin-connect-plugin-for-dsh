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

  it('should support SWR (stale-while-revalidate)', async () => {
    const cache = new MemoryCache(10)
    
    // First call
    const factory1 = jest.fn().mockResolvedValue('old-data')
    await cache.getOrSet('key', factory1)
    
    // Move time past TTL
    jest.advanceTimersByTime(11000)

    // Second call - should return stale immediately, then fetch in background
    let resolveNewData!: (val: string) => void
    const factory2 = jest.fn().mockReturnValue(new Promise(r => { resolveNewData = r }))
    
    const v2 = await cache.getOrSet('key', factory2)
    expect(v2).toBe('old-data') // Got stale data immediately
    expect(factory2).toHaveBeenCalledTimes(1)

    // Background fetch completes
    resolveNewData('new-data')
    // Wait a tick for promise to resolve
    await Promise.resolve()

    // Third call should return new data immediately
    const v3 = await cache.getOrSet('key', factory2)
    expect(v3).toBe('new-data')
    expect(factory2).toHaveBeenCalledTimes(1) // Background fetch already completed
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
})
