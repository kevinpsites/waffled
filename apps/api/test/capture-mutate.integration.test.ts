// Capture Tier 2 spine — the two dispatcher routes for an UNREGISTERED target kind,
// plus finalizeIntent's mutate branch. Real PG (Testcontainers) + app.run, mirroring
// capture.integration.test.ts. Real target kinds register in Phase B (chore is live
// now), so this exercises a bogus kind: resolve says unsupported and commit 400s.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { finalizeIntent } from '../src/modules/capture/capture'
import { registerCaptureTarget, type CaptureTarget } from '../src/modules/capture/capture-resolvers'

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
  it('flags an unregistered target kind as unsupported (not a silent no-match)', async () => {
    const res = await call('POST', '/api/capture/resolve', kevin, {
      targetKind: 'unicorn', verb: 'complete', target: { description: 'x' }, args: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.candidates).toEqual([])
    expect(body.unsupported).toBe(true)
    expect(typeof body.disabledReason).toBe('string')
    expect(body.disabledReason.length).toBeGreaterThan(0)
  })

  it('gives a per-kind friendly reason for a parser-emitted but unregistered kind (event)', async () => {
    const res = await call('POST', '/api/capture/resolve', kevin, {
      targetKind: 'event', verb: 'reschedule', target: { description: 'soccer' }, args: { date: '2026-07-20' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.candidates).toEqual([])
    expect(body.unsupported).toBe(true)
    expect(body.disabledReason).toMatch(/calendar/i)
  })
})

describe('POST /api/capture/resolve — verb the target does not support', () => {
  it('says unsupported (with a friendly reason) for delete on a goal', async () => {
    const res = await call('POST', '/api/capture/resolve', kevin, {
      targetKind: 'goal', verb: 'delete', target: { description: 'reading goal' }, args: {},
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.candidates).toEqual([])
    expect(body.unsupported).toBe(true)
    expect(body.disabledReason).toMatch(/delete/i)
    expect(body.disabledReason).toMatch(/goal/i)
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

  it('400s with the same friendly reason for a verb the target does not support', async () => {
    const res = await call('POST', '/api/capture/commit', kevin, {
      targetKind: 'goal', verb: 'delete', targetId: '00000000-0000-4000-8000-000000000000', args: {},
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.message).toMatch(/delete/i)
    expect(body.message).toMatch(/goal/i)
  })

  it('400s a friendly message (not a raw Postgres uuid error) for a malformed targetId', async () => {
    const res = await call('POST', '/api/capture/commit', kevin, {
      targetKind: 'chore', verb: 'complete', targetId: 'nope', args: {},
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.message).not.toMatch(/invalid input syntax/i)
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })
})

describe('dispatcher error handling — a target that blows up (raw non-HTTP errors)', () => {
  // A stand-in target registered under a real (but otherwise unregistered) kind whose
  // resolver/applier throw raw infra-style errors — the dispatcher must NOT relay them.
  const boom: CaptureTarget = {
    isEnabled: () => true,
    disabledReason: 'x',
    supportedVerbs: ['redeem'],
    resolveCandidates: async () => { throw new Error('duplicate key value violates unique constraint "boom"') },
    applyMutation: async () => { throw new Error('connection terminated unexpectedly') },
  }
  beforeAll(() => registerCaptureTarget('reward', boom))

  it('resolve → 500 (logged), never a silent 200 candidates:[]', async () => {
    const res = await call('POST', '/api/capture/resolve', kevin, {
      targetKind: 'reward', verb: 'redeem', target: { description: 'ice cream' }, args: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).message).not.toMatch(/duplicate key/i)
  })

  it('commit → 500 with a generic message, never the raw error text', async () => {
    const res = await call('POST', '/api/capture/commit', kevin, {
      targetKind: 'reward', verb: 'redeem', targetId: '00000000-0000-4000-8000-000000000000', args: {},
    })
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body).message).not.toMatch(/connection terminated/i)
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
      kind: 'mutate', verb: 'log', targetKind: 'goal', target: { description: 'reading goal' }, args: { minutes: 20 },
    })
  })

  it('defaults missing args to an empty object', () => {
    const i = finalizeIntent({ kind: 'mutate', verb: 'complete', targetKind: 'chore', target: { description: 'trash' } }, ctx)
    expect(i.args).toEqual({})
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
