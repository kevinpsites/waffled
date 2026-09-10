import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiGet, trackedFetch } from './client'
import { getServerReachability, isUnansweredError, resetReachability } from './reachability'

// A Response stand-in: only the bits the client reads (status, content-type, body).
function res(status: number, contentType: string | null, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response
}

describe('trackedFetch as a reachability sample', () => {
  beforeEach(() => resetReachability())
  afterEach(() => {
    resetReachability()
    vi.restoreAllMocks()
  })

  it('tags and reports a request that never got an answer', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    const err = await trackedFetch('/api/anything').catch((e: unknown) => e)
    expect(isUnansweredError(err)).toBe(true)

    await trackedFetch('/api/anything').catch(() => {})
    expect(getServerReachability()).toBe('unreachable')
  })

  it('says nothing about the server when the caller aborted the request itself', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }) as unknown as typeof fetch
    const control = new AbortController()
    control.abort()

    for (const _ of [1, 2]) {
      const err = await trackedFetch('/api/anything', { signal: control.signal }).catch((e: unknown) => e)
      expect(isUnansweredError(err)).toBe(false)
    }
    expect(getServerReachability()).toBe('reachable')

    // The signal itself is not the point — a live one carrying the same rejection is
    // the server going quiet, and still counts.
    const live = new AbortController()
    for (const _ of [1, 2]) {
      const err = await trackedFetch('/api/anything', { signal: live.signal }).catch((e: unknown) => e)
      expect(isUnansweredError(err)).toBe(true)
    }
    expect(getServerReachability()).toBe('unreachable')
  })

  it('treats a 401 as an answer', async () => {
    globalThis.fetch = vi.fn(async () => res(401, 'application/json')) as unknown as typeof fetch

    expect((await trackedFetch('/api/anything')).status).toBe(401)
    expect(getServerReachability()).toBe('reachable')
  })
})

describe('client reachability tagging', () => {
  beforeEach(() => resetReachability())
  afterEach(() => {
    resetReachability()
    vi.restoreAllMocks()
  })

  it('leaves a 502 the api answered in its own JSON untagged', async () => {
    globalThis.fetch = vi.fn(async () => res(502, 'application/json', { error: 'IngestFailed' })) as unknown as typeof fetch

    const err = await apiGet('/api/meals/ingest').catch((e: unknown) => e)

    expect(isUnansweredError(err)).toBe(false)
    expect(getServerReachability()).toBe('reachable')
  })

  it('tags a gateway 502 that is not ours', async () => {
    globalThis.fetch = vi.fn(async () => res(502, 'text/plain')) as unknown as typeof fetch

    const err = await apiGet('/api/meals/ingest').catch((e: unknown) => e)

    expect(isUnansweredError(err)).toBe(true)
  })
})
