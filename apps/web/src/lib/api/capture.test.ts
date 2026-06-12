import { captureApi } from './capture'

// captureApi.resolve should prefer the server parse but fall back to the
// on-device heuristic whenever the server defers, errors, or we're offline.
describe('captureApi.resolve', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the server intent when one is returned', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ intent: { kind: 'grocery', name: 'Milk', quantity: null }, via: 'anthropic', fallback: false }),
    })) as unknown as typeof fetch
    const r = await captureApi.resolve('grab milk', [])
    expect(r.via).toBe('anthropic')
    expect(r.intent).toMatchObject({ kind: 'grocery', name: 'Milk' })
  })

  it('falls back to on-device when the server says fallback', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ intent: null, via: 'heuristic', fallback: true }),
    })) as unknown as typeof fetch
    const r = await captureApi.resolve('2 lbs chicken', [])
    expect(r.via).toBe('on-device')
    expect(r.intent).toMatchObject({ kind: 'grocery', name: 'Chicken', quantity: '2 lbs' })
  })

  it('falls back to on-device when the request throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const r = await captureApi.resolve('Soccer Tue 4pm for Wally', ['Wally'])
    expect(r.via).toBe('on-device')
    expect(r.intent?.kind).toBe('event')
  })
})
