// AI "Plan my week" (6.3) over the shared LLM layer (src/llm.ts) — stubs an
// OpenAI-compatible endpoint (the household's selected provider) and checks the
// suggestions are validated: only empty dinner dates, once each, library recipeId
// kept only when real. Also: 501 when no provider is configured.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let stub: Server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let nextSuggestions: unknown[] = []

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}
const kevin = mint('dev|kevin')

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

// Minimal OpenAI-compatible chat/completions stub returning our staged JSON.
function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && (req.url ?? '').includes('/chat/completions')) {
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: nextSuggestions }) } }] }))
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
  delete process.env.AUTH0_DOMAIN
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`

  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('plan my week', () => {
  it('501s when no AI provider is selected', async () => {
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-07-01' })
    expect(res.statusCode).toBe(501)
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
