// Capture Tier 2 spine — the two dispatcher routes for an UNREGISTERED target kind,
// plus finalizeIntent's mutate branch. Real PG (Testcontainers) + app.run, mirroring
// capture.integration.test.ts. Real target kinds register in Phase B (chore is live
// now), so this exercises a bogus kind: resolve returns [] and commit 400s Unsupported.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { finalizeIntent } from '../src/modules/capture/capture'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

let kevin = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
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
  await pg?.stop()
})

// Silence the unused-mint lint (kept for parity with the sibling harness).
void mint

describe('POST /api/capture/resolve — dispatcher with an unregistered target kind', () => {
  it('returns an empty candidate list for an unregistered target kind', async () => {
    const res = await call('POST', '/api/capture/resolve', kevin, {
      targetKind: 'unicorn', verb: 'complete', target: { description: 'x' }, args: {},
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ candidates: [] })
  })
})

describe('POST /api/capture/commit — dispatcher with an unregistered target kind', () => {
  it('400s Unsupported for an unregistered target kind', async () => {
    const res = await call('POST', '/api/capture/commit', kevin, {
      targetKind: 'unicorn', verb: 'complete', targetId: 'nope', args: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('Unsupported')
  })
})

describe('finalizeIntent — mutate branch (raw model JSON → typed intent)', () => {
  const ctx = { now: '2026-06-11T09:00:00Z', timezone: 'America/Chicago', people: ['Wally', 'Lottie'] }

  it('maps a raw mutate object to a typed intent, passing args through', () => {
    const i = finalizeIntent(
      { kind: 'mutate', verb: 'log', targetKind: 'goal', target: { description: 'reading goal' }, args: { minutes: 20 } },
      ctx
    )
    expect(i).toEqual({
      kind: 'mutate', verb: 'log', targetKind: 'goal', target: { description: 'reading goal' }, mutateArgs: { minutes: 20 },
    })
  })

  it('defaults missing args to an empty object', () => {
    const i = finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'chore', target: { description: 'trash' } }, ctx)
    expect(i.mutateArgs).toEqual({})
  })

  it('accepts the camelCase listItem target kind', () => {
    const i = finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'listItem', target: { description: 'milk' } }, ctx)
    expect(i.targetKind).toBe('listItem')
  })

  it('throws when the target description is missing or empty', () => {
    expect(() => finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'chore', target: {} }, ctx)).toThrow()
    expect(() => finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'chore' }, ctx)).toThrow()
    expect(() => finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'chore', target: { description: '  ' } }, ctx)).toThrow()
  })

  it('throws on an unknown verb or target kind', () => {
    expect(() => finalizeIntent({ kind: 'mutate', verb: 'frobnicate', targetKind: 'chore', target: { description: 'x' } }, ctx)).toThrow()
    expect(() => finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'unicorn', target: { description: 'x' } }, ctx)).toThrow()
  })
})
