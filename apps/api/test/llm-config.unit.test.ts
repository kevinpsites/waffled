import { describe, it, expect, vi, afterEach } from 'vitest'
import { toStrictSchema } from '../src/platform/llm'

// Regression net for the "present-but-empty env var" class of bug: a .env that
// keeps the placeholder lines (OPENAI_BASE_URL=, OPENAI_MODEL=) used to defeat the
// `?? default` fallbacks because `""` is not nullish — yielding a hostless
// "/chat/completions" ("Failed to parse URL") and an empty model. See config.ts:env().

const AI_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OLLAMA_HOST', 'OLLAMA_MODEL',
] as const

// Load a fresh copy of config with a specific env slice. config resolves at module
// load, so we reset the module registry and re-import per case.
async function loadConfig(env: Partial<Record<(typeof AI_KEYS)[number], string>>) {
  const saved: Record<string, string | undefined> = {}
  for (const k of AI_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  vi.resetModules()
  try {
    return (await import('../src/platform/config')).default
  } finally {
    for (const k of AI_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

describe('config.ai — empty env vars fall back to defaults', () => {
  afterEach(() => vi.resetModules())

  it('empty OPENAI_BASE_URL falls back to the hosted API (not "")', async () => {
    const c = await loadConfig({ OPENAI_BASE_URL: '', OPENAI_MODEL: '' })
    expect(c.ai.openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(c.ai.openai.defaultModel).toBe('gpt-4o-mini')
  })

  it('whitespace-only values are treated as unset', async () => {
    const c = await loadConfig({ OPENAI_MODEL: '   ', ANTHROPIC_MODEL: '\t' })
    expect(c.ai.openai.defaultModel).toBe('gpt-4o-mini')
    expect(c.ai.anthropic.defaultModel).toBe('claude-haiku-4-5-20251001')
  })

  it('unset vars use the defaults (baseline)', async () => {
    const c = await loadConfig({})
    expect(c.ai.openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(c.ai.anthropic.defaultModel).toBe('claude-haiku-4-5-20251001')
    expect(c.ai.ollama.defaultModel).toBe('llama3.1')
  })

  it('real values pass through unchanged', async () => {
    const c = await loadConfig({ OPENAI_BASE_URL: 'http://lmstudio:1234/v1', OPENAI_MODEL: 'gpt-4o' })
    expect(c.ai.openai.baseUrl).toBe('http://lmstudio:1234/v1')
    expect(c.ai.openai.defaultModel).toBe('gpt-4o')
  })

  it('an empty API key reads as null (provider stays unavailable)', async () => {
    const c = await loadConfig({ OPENAI_API_KEY: '' })
    expect(c.ai.openai.apiKey).toBeNull()
  })
})

describe('toStrictSchema — OpenAI strict Structured Outputs conformance', () => {
  it('marks every property required and pins objects closed, preserving nullability', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['a', 'b'] },
        note: { type: ['string', 'null'] },
      },
      required: ['kind'],
    }) as any
    expect(strict.additionalProperties).toBe(false)
    expect(strict.required.sort()).toEqual(['kind', 'note'])
    expect(strict.properties.note.type).toEqual(['string', 'null']) // nullability untouched
    expect(strict.properties.kind.enum).toEqual(['a', 'b']) // enums untouched
  })

  it('recurses into array items and nested objects', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { date: { type: 'string' }, note: { type: ['string', 'null'] } }, required: ['date'] },
        },
      },
      required: ['items'],
    }) as any
    const item = strict.properties.items.items
    expect(item.additionalProperties).toBe(false)
    expect(item.required.sort()).toEqual(['date', 'note'])
  })

  it('leaves a schema with no properties (bare array/scalar) alone', () => {
    expect(toStrictSchema({ type: 'array', items: { type: 'string' } })).toEqual({ type: 'array', items: { type: 'string' } })
  })
})

describe('getAiConfig — a persisted empty model falls back to the provider default', () => {
  afterEach(() => vi.resetModules())

  async function withHouseholdAi(ai: unknown) {
    vi.resetModules()
    vi.doMock('../src/platform/db', () => ({
      query: vi.fn(async () => ({ rows: [{ settings: { ai } }] })),
    }))
    return await import('../src/platform/llm')
  }

  it('provider=openai with model:"" resolves to gpt-4o-mini, not ""', async () => {
    const llm = await withHouseholdAi({ provider: 'openai', model: '' })
    const cfg = await llm.getAiConfig('h1')
    expect(cfg.provider).toBe('openai')
    expect(cfg.model).toBe('gpt-4o-mini')
  })

  it('a blank/whitespace model is treated as unset', async () => {
    const llm = await withHouseholdAi({ provider: 'anthropic', model: '  ' })
    const cfg = await llm.getAiConfig('h1')
    expect(cfg.model).toBe('claude-haiku-4-5-20251001')
  })

  it('an explicit model is preserved', async () => {
    const llm = await withHouseholdAi({ provider: 'openai', model: 'gpt-4o' })
    const cfg = await llm.getAiConfig('h1')
    expect(cfg.model).toBe('gpt-4o')
  })

  it('no ai settings → heuristic provider, null model', async () => {
    const llm = await withHouseholdAi(undefined)
    const cfg = await llm.getAiConfig('h1')
    expect(cfg.provider).toBe('heuristic')
    expect(cfg.model).toBeNull()
  })
})

// A transient provider blip (OpenAI 500 "you can retry", a dropped socket) shouldn't
// sink the user's action — completeJson retries those, but not a permanent 4xx.
describe('completeJson — retries transient provider failures', () => {
  const OLD_KEY = process.env.OPENAI_API_KEY
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    if (OLD_KEY === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = OLD_KEY
  })

  async function loadLlmOpenai() {
    process.env.OPENAI_API_KEY = 'test-key' // makes the openai provider "available"
    vi.resetModules()
    vi.doMock('../src/platform/db', () => ({
      query: vi.fn(async () => ({ rows: [{ settings: { ai: { provider: 'openai', model: 'gpt-4o-mini' } } }] })),
    }))
    return await import('../src/platform/llm')
  }
  const okResponses = {
    ok: true, status: 200,
    json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"suggestions":[]}' }] }] }),
    text: async () => '',
  }
  const httpFail = (status: number) => ({ ok: false, status, text: async () => `${status} server_error`, json: async () => ({}) })
  const req = { system: 's', user: 'u', schema: {}, schemaName: 'meal_plan', maxTokens: 10 }

  it('retries a 500 then succeeds', async () => {
    const llm = await loadLlmOpenai()
    const fetchMock = vi.fn().mockResolvedValueOnce(httpFail(500)).mockResolvedValueOnce(okResponses)
    vi.stubGlobal('fetch', fetchMock)
    const r = await llm.completeJson('h1', req)
    expect(r.via).toBe('openai')
    expect(r.data).toEqual({ suggestions: [] })
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it('does NOT retry a 400 (bad request / auth) — fails immediately', async () => {
    const llm = await loadLlmOpenai()
    const fetchMock = vi.fn().mockResolvedValue(httpFail(400))
    vi.stubGlobal('fetch', fetchMock)
    await expect(llm.completeJson('h1', req)).rejects.toThrow()
    expect(fetchMock.mock.calls.length).toBe(1)
  })

  it('gives up after exhausting retries on a persistent 5xx (1 + 2 tries)', async () => {
    const llm = await loadLlmOpenai()
    const fetchMock = vi.fn().mockResolvedValue(httpFail(503))
    vi.stubGlobal('fetch', fetchMock)
    await expect(llm.completeJson('h1', req)).rejects.toThrow()
    expect(fetchMock.mock.calls.length).toBe(3)
  })
})
