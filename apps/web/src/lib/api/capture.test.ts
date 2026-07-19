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

// TIER 2 (F1) — a server mutate intent carries the verb args under `args` (older server
// builds said `mutateArgs`). Both spellings must land on intent.args so the /resolve and
// /commit calls receive them (dropping them turned "give the dishes to Wally" into a
// reassign with no assignee).
describe('captureApi.resolve — mutate args normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const serverMutate = (extra: Record<string, unknown>) => ({
    ok: true,
    json: async () => ({
      intent: { kind: 'mutate', verb: 'reassign', targetKind: 'chore', target: { description: 'dishes' }, ...extra },
      via: 'anthropic',
      fallback: false,
    }),
  })

  it('keeps a server mutate intent’s `args` on intent.args', async () => {
    globalThis.fetch = vi.fn(async () => serverMutate({ args: { personName: 'Wally' } })) as unknown as typeof fetch
    const r = await captureApi.resolve('give the dishes to Wally', ['Wally'])
    expect(r.via).toBe('anthropic')
    expect(r.intent).toMatchObject({ kind: 'mutate', verb: 'reassign', args: { personName: 'Wally' } })
  })

  it('normalizes the legacy `mutateArgs` spelling onto intent.args', async () => {
    globalThis.fetch = vi.fn(async () => serverMutate({ mutateArgs: { personName: 'Wally' } })) as unknown as typeof fetch
    const r = await captureApi.resolve('give the dishes to Wally', ['Wally'])
    expect(r.intent).toMatchObject({ kind: 'mutate', args: { personName: 'Wally' } })
  })

  it('defaults a server mutate with neither spelling to args {}', async () => {
    globalThis.fetch = vi.fn(async () => serverMutate({})) as unknown as typeof fetch
    const r = await captureApi.resolve('give the dishes to Wally', ['Wally'])
    expect((r.intent as { args?: unknown }).args).toEqual({})
  })
})
