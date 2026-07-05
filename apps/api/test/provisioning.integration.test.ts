// P2.6 of multi-household identity (docs/design/multi-household-identity.md §5.8,
// decision 4): creating a household is ADMIN-GATED. The first household is created
// by the first-run wizard (/api/auth/setup); after that, POST /api/households lets
// an existing ADMIN spin up an *additional* household (becoming its owner), linked
// to their existing account. Open self-serve onboarding — a brand-new, unprovisioned
// token creating its own household — is intentionally deferred to a sell-time lift,
// so it is rejected here. (This replaces the former self-serve first-login flow.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let kevinToken = ''   // owner/admin of household A
let teenToken = ''    // non-admin member of A
let kevinAccountId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown): Promise<RunResult> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)
const login = async (email: string, password: string) => json(await call('POST', '/api/auth/login', undefined, { email, password }))

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  process.env.LOCAL_JWT_SECRET = SECRET
  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinToken = (await login('kevin@example.com', 'ownerpass1')).accessToken
  kevinAccountId = (await query(`select id from accounts where lower(email)='kevin@example.com' and deleted_at is null`)).rows[0].id

  const teenId = json(await call('POST', '/api/persons', kevinToken, { name: 'Teeny', memberType: 'teen' })).person.id
  await call('PUT', `/api/persons/${teenId}/login`, kevinToken, { email: 'teen@example.com', password: 'teenpass12' })
  teenToken = (await login('teen@example.com', 'teenpass12')).accessToken
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P2.6 admin-gated household creation', () => {
  it('rejects an unauthenticated request (401)', async () => {
    expect((await call('POST', '/api/households', undefined, { name: 'X', timezone: 'UTC', person: { name: 'X' } })).statusCode).toBe(401)
  })

  it('reports unprovisioned and refuses self-serve creation for a brand-new account (403)', async () => {
    const stranger = mint('dev|stranger')
    expect(json(await call('GET', '/api/household', stranger))).toEqual({ provisioned: false })
    // Open self-serve onboarding is deferred — an unprovisioned token cannot create one.
    expect((await call('POST', '/api/households', stranger, { name: 'Solo', timezone: 'UTC', person: { name: 'Solo' } })).statusCode).toBe(403)
  })

  it('refuses a non-admin member (403)', async () => {
    expect((await call('POST', '/api/households', teenToken, { name: 'Nope', timezone: 'UTC', person: { name: 'Teeny' } })).statusCode).toBe(403)
  })

  it('rejects an incomplete body from an admin (400)', async () => {
    expect((await call('POST', '/api/households', kevinToken, { name: 'C' })).statusCode).toBe(400)
  })

  it('lets an admin create an additional household, linked to the same account', async () => {
    const res = await call('POST', '/api/households', kevinToken, {
      name: 'The Lake House',
      timezone: 'America/Chicago',
      person: { name: 'Kevin', avatarEmoji: '🏔️' },
    })
    expect(res.statusCode).toBe(201)
    const { household, person } = json(res)
    expect(person).toMatchObject({ name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🏔️' })
    expect(household).toMatchObject({ name: 'The Lake House', timezone: 'America/Chicago', ownerPersonId: person.id })
    expect(person.householdId).toBe(household.id)

    // Linked to Kevin's EXISTING account — no new account row was created.
    const linked = await query(`select account_id from persons where id=$1`, [person.id])
    expect(linked.rows[0].account_id).toBe(kevinAccountId)
    expect((await query(`select count(*)::int n from accounts where lower(email)='kevin@example.com' and deleted_at is null`)).rows[0].n).toBe(1)

    // Kevin can switch into the new household and is its owner/admin.
    const sw = json(await call('POST', '/api/auth/switch', kevinToken, { householdId: household.id }))
    const ctx = json(await call('GET', '/api/household', sw.accessToken))
    expect(ctx.household.name).toBe('The Lake House')
    expect(ctx.person).toMatchObject({ isAdmin: true })
  })
})
