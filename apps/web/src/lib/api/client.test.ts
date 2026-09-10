import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiGet } from './client'
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
