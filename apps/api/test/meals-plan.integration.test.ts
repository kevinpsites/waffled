// AI "Plan my week" (6.3) over the shared LLM layer (src/llm.ts) — stubs an
// OpenAI-compatible endpoint (the household's selected provider) and checks the
// suggestions are validated: only empty dinner dates, once each, library recipeId
// kept only when real. Also: 501 when no provider is configured.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let stub: Server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let nextSuggestions: unknown[] = []

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
let kevin = ''

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

// Minimal OpenAI Responses-API stub returning our staged JSON as output_text
// (the shape openaiJson now parses — see src/platform/llm.ts).
function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && (req.url ?? '').includes('/responses')) {
        const text = JSON.stringify({ suggestions: nextSuggestions })
        res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)
  const port = await startStub()
  process.env.DATABASE_URL = dbUrl
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`

  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

// Shuffle fallback: when NO AI provider is configured, the household default is
// 'heuristic', so POST /api/meals/plan-week no longer 501s — it fills the empty
// slots with random *library* recipes, skipping anything already planned this week
// or cooked in the last ~14 days. These run BEFORE the provider is switched to
// 'openai' further down, so heuristic (no provider) is the active selection.
describe('shuffle week (no AI provider)', () => {
  async function makeRecipe(title: string, extra: Record<string, unknown> = {}) {
    const res = await call('POST', '/api/recipes', kevin, { title, ...extra })
    expect(res.statusCode).toBe(201)
    return JSON.parse(res.body).recipe as { id: string; title: string }
  }

  // Covers "skips a recipe cooked in the last 14 days; an un-cooked one is eligible".
  // Runs first, so the library is exactly {cooked, fresh}: excluding the cooked one
  // leaves a single eligible recipe, making the pick deterministic.
  it('skips a recipe cooked in the last 14 days but keeps an un-cooked one', async () => {
    const cooked = await makeRecipe('Sh Recently Cooked')
    const fresh = await makeRecipe('Sh Never Cooked') // last_cooked_at stays null
    expect((await call('POST', `/api/recipes/${cooked.id}/cooked`, kevin)).statusCode).toBe(200)
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-09-06' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.via).toBe('shuffle')
    // Only the never-cooked recipe is eligible → it (and only it) is suggested.
    const ids = body.suggestions.map((s: { recipeId: string }) => s.recipeId)
    expect(ids.every((id: string) => id === fresh.id)).toBe(true)
    expect(ids).not.toContain(cooked.id)
  })

  // Covers "graceful when eligible pool < empty slots (fills what it can)".
  it('fills what it can when the eligible pool is smaller than the empty slots', async () => {
    // Library so far: {cooked (excluded), fresh}. Add one → 2 eligible for a 7-day week.
    const extra = await makeRecipe('Sh Small Pool Extra')
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-09-13' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.via).toBe('shuffle')
    // Two eligible recipes, seven empty slots → fills two, no crash, no repeat.
    expect(body.suggestions.length).toBe(2)
    const ids = body.suggestions.map((s: { recipeId: string }) => s.recipeId)
    expect(new Set(ids).size).toBe(2)
    for (const s of body.suggestions) {
      expect(s).toMatchObject({ mealType: 'dinner', note: 'Shuffled' })
      expect(typeof s.recipeId).toBe('string') // always a real library recipe
    }
    void extra
  })

  // Covers "fills every empty target date from the library".
  it('fills every empty target date from the library', async () => {
    for (const t of ['Sh Curry', 'Sh Chili', 'Sh Pasta', 'Sh Roast', 'Sh Stir Fry', 'Sh Pie']) await makeRecipe(t)
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-09-20' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.via).toBe('shuffle')
    const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
    expect(new Set(body.suggestions.map((s: { date: string }) => s.date))).toEqual(new Set(days))
    const ids = body.suggestions.map((s: { recipeId: string }) => s.recipeId)
    for (const id of ids) expect(typeof id).toBe('string') // every card links a real recipe
    expect(new Set(ids).size).toBe(ids.length) // no recipe used twice
  })

  // Covers "skips a recipe already planned this week".
  it('skips a recipe already planned this week', async () => {
    const planned = await makeRecipe('Sh Already Planned')
    const pre = await call('POST', '/api/meals/plan', kevin, { date: '2026-09-28', mealType: 'dinner', recipeId: planned.id })
    expect(pre.statusCode).toBeLessThan(300)
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-09-27' })
    const body = JSON.parse(res.body)
    expect(body.via).toBe('shuffle')
    // The already-planned recipe is not re-suggested, and its filled day is not a target.
    expect(body.suggestions.some((s: { recipeId: string }) => s.recipeId === planned.id)).toBe(false)
    expect(body.suggestions.some((s: { date: string }) => s.date === '2026-09-28')).toBe(false)
  })

  // Covers "leaves already-filled slots untouched".
  it('leaves already-filled slots untouched', async () => {
    const pre = await call('POST', '/api/meals/plan', kevin, { date: '2026-10-06', mealType: 'dinner', title: 'Eating out' })
    expect(pre.statusCode).toBeLessThan(300)
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-10-04' })
    const body = JSON.parse(res.body)
    expect(body.via).toBe('shuffle')
    expect(body.suggestions.some((s: { date: string }) => s.date === '2026-10-06')).toBe(false) // untouched
    expect(body.suggestions.length).toBeGreaterThan(0)
  })
})

describe('plan my week', () => {
  // With no provider configured (heuristic default) plan-week now shuffles the empty
  // slots from the library instead of 501ing. (Previously asserted a 501.)
  it('shuffles the week when no AI provider is selected', async () => {
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-07-01' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).via).toBe('shuffle')
  })

  it('returns validated dinner suggestions for empty days', async () => {
    // Select the (stubbed) OpenAI provider for this household.
    expect((await call('PUT', '/api/capture/config', kevin, { provider: 'openai' })).statusCode).toBe(200)
    // A library recipe so a real recipeId reuse can be verified.
    const tacos = JSON.parse((await call('POST', '/api/recipes', kevin, { title: 'Tacos' })).body).recipe

    nextSuggestions = [
      { date: '2026-07-01', title: 'Tacos', recipeId: tacos.id },
      { date: '2026-07-02', title: 'Lentil Soup', recipeId: null },
      { date: '2026-07-01', title: 'Duplicate day', recipeId: null }, // same date → dropped
      { date: '1999-01-01', title: 'Out of window', recipeId: null }, // not requested → dropped
      { date: '2026-07-03', title: 'Bad ref', recipeId: 'not-a-real-id' }, // recipeId nulled
    ]
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-07-01' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.via).toBe('openai')
    const byDate = Object.fromEntries(body.suggestions.map((s: { date: string }) => [s.date, s]))
    expect(body.suggestions).toHaveLength(3)
    expect(byDate['2026-07-01']).toMatchObject({ title: 'Tacos', recipeId: tacos.id, mealType: 'dinner' })
    expect(byDate['2026-07-02']).toMatchObject({ title: 'Lentil Soup', recipeId: null })
    expect(byDate['2026-07-03']).toMatchObject({ title: 'Bad ref', recipeId: null }) // invalid id dropped
    expect(byDate['1999-01-01']).toBeUndefined()
  })

  it('links a suggestion to a library recipe by title when the model omits the id', async () => {
    const quiche = JSON.parse((await call('POST', '/api/recipes', kevin, { title: 'Veggie Quiche', emoji: '🥧' })).body).recipe
    // model echoes the library title but returns recipeId null (what small models do)
    nextSuggestions = [{ date: '2026-07-05', title: 'veggie quiche', recipeId: null }]
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-07-01' })
    const card = JSON.parse(res.body).suggestions.find((s: { date: string }) => s.date === '2026-07-05')
    expect(card).toMatchObject({ recipeId: quiche.id, title: 'Veggie Quiche', emoji: '🥧' }) // relinked + canonical title/emoji
  })

  it('skips days that already have a dinner planned', async () => {
    await call('POST', '/api/meals/plan', kevin, { date: '2026-07-01', mealType: 'dinner', title: 'Already planned' })
    nextSuggestions = [{ date: '2026-07-01', title: 'Should be ignored', recipeId: null }]
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-07-01' })
    const body = JSON.parse(res.body)
    expect(body.suggestions.find((s: { date: string }) => s.date === '2026-07-01')).toBeUndefined()
  })
})
