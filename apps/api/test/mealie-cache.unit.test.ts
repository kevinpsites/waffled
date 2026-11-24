import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cacheGet, cacheClear, __resetMealieCache, __mealieCacheSize } from '../src/modules/mealie/mealie-cache'

describe('mealie cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetMealieCache()
  })
  afterEach(() => vi.useRealTimers())

  it('serves a second read within the TTL without loading', async () => {
    const load = vi.fn(async () => 'a')
    expect(await cacheGet('h', 'plan', 'k', load)).toBe('a')
    expect(await cacheGet('h', 'plan', 'k', load)).toBe('a')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads after the TTL', async () => {
    const load = vi.fn(async () => 'a')
    await cacheGet('h', 'plan', 'k', load)
    vi.advanceTimersByTime(30_001)
    await cacheGet('h', 'plan', 'k', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('clears only the given kind for that household', async () => {
    const shop = vi.fn(async () => 's')
    const plan = vi.fn(async () => 'p')
    await cacheGet('h', 'shopping', 'k', shop)
    await cacheGet('h', 'plan', 'k', plan)
    cacheClear('h', 'shopping')
    await cacheGet('h', 'shopping', 'k', shop)
    await cacheGet('h', 'plan', 'k', plan)
    expect(shop).toHaveBeenCalledTimes(2)
    expect(plan).toHaveBeenCalledTimes(1)
  })

  it('clears every kind when none is given, leaving other households alone', async () => {
    const a = vi.fn(async () => 'a')
    const b = vi.fn(async () => 'b')
    await cacheGet('h1', 'plan', 'k', a)
    await cacheGet('h2', 'plan', 'k', b)
    cacheClear('h1')
    await cacheGet('h1', 'plan', 'k', a)
    await cacheGet('h2', 'plan', 'k', b)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('ok')
    await expect(cacheGet('h', 'plan', 'k', load)).rejects.toThrow('x')
    expect(await cacheGet('h', 'plan', 'k', load)).toBe('ok')
  })

  it('evicts expired entries instead of letting the map grow', async () => {
    await cacheGet('h', 'plan', 'a', async () => 1)
    await cacheGet('h', 'plan', 'b', async () => 2)
    vi.advanceTimersByTime(30_001)
    await cacheGet('h', 'plan', 'c', async () => 3)
    expect(__mealieCacheSize()).toBe(1)
    vi.advanceTimersByTime(30_001)
    await cacheGet('h', 'plan', 'c', async () => 4)
    expect(__mealieCacheSize()).toBe(1)
  })
})
