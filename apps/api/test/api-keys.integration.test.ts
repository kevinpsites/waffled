// Per-user API keys: management CRUD (session-authed) + the x-api-key auth path and
// its central scope gate, against a real Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

function keyCall(method: string, path: string, key: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-api-key': key }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
let householdId = ''
let ownerId = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = JSON.parse(setup.body).household.id
  ownerId = JSON.parse(setup.body).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('api-keys management (session)', () => {
  it('requires a session to manage keys', async () => {
    expect((await call('POST', '/api/api-keys', undefined, { name: 'x', scopes: ['lists:read'] })).statusCode).toBe(401)
  })

  it('exposes the grantable scope catalog', async () => {
    const res = await call('GET', '/api/api-keys/scopes', kevin)
    expect(res.statusCode).toBe(200)
    const resources = JSON.parse(res.body).scopes.map((s: { resource: string }) => s.resource)
    expect(resources).toEqual(expect.arrayContaining(['family', 'lists', 'chores', 'meals']))
  })

  it('validates name + scopes on create', async () => {
    expect((await call('POST', '/api/api-keys', kevin, { scopes: ['lists:read'] })).statusCode).toBe(400)
    expect((await call('POST', '/api/api-keys', kevin, { name: 'x', scopes: [] })).statusCode).toBe(400)
    expect((await call('POST', '/api/api-keys', kevin, { name: 'x', scopes: ['bogus:read'] })).statusCode).toBe(400)
    expect((await call('POST', '/api/api-keys', kevin, { name: 'x', scopes: ['family:write'] })).statusCode).toBe(400) // family is read-only
  })

  it('mints a key (secret returned once) and lists it without the secret', async () => {
    const res = await call('POST', '/api/api-keys', kevin, { name: 'Home Assistant', scopes: ['family:read', 'lists:read'] })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.key).toMatch(/^waffled_/)
    expect(body.apiKey).toMatchObject({ name: 'Home Assistant', scopes: ['family:read', 'lists:read'] })
    expect(body.apiKey.prefix).toBe(body.key.slice(0, 12))

    const list = JSON.parse((await call('GET', '/api/api-keys', kevin)).body)
    expect(list.keys).toHaveLength(1)
    expect(list.keys[0]).not.toHaveProperty('key')
    expect(list.keys[0]).not.toHaveProperty('keyHash')
  })
})

describe('api-key authentication + scope gate', () => {
  let readKey = '' // family:read + lists:read
  let writeKey = '' // lists:read + lists:write

  beforeAll(async () => {
    readKey = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'reader', scopes: ['family:read', 'lists:read'] })).body).key
    writeKey = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'writer', scopes: ['lists:read', 'lists:write'] })).body).key
  })

  it('rejects an unknown key (401)', async () => {
    expect((await keyCall('GET', '/api/household', 'waffled_not_a_real_key')).statusCode).toBe(401)
  })

  it('resolves the owner tenant on a scoped read', async () => {
    const res = await keyCall('GET', '/api/household', readKey)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provisioned).toBe(true)
    expect(body.household.id).toBe(householdId)
  })

  it('allows reads within scope, denies reads outside it', async () => {
    expect((await keyCall('GET', '/api/lists', readKey)).statusCode).toBe(200)
    expect((await keyCall('GET', '/api/chores/today', readKey)).statusCode).toBe(403)
  })

  it('requires :write for mutations', async () => {
    expect((await keyCall('POST', '/api/lists', readKey, { name: 'Camping' })).statusCode).toBe(403)
    expect((await keyCall('POST', '/api/lists', writeKey, { name: 'Camping' })).statusCode).toBe(201)
  })

  it('never allows writes to a read-only resource', async () => {
    expect((await keyCall('PATCH', `/api/persons/${ownerId}`, readKey, { name: 'Kev' })).statusCode).toBe(403)
  })

  it('blocks paths not exposed to keys, including key management', async () => {
    expect((await keyCall('GET', '/api/permissions', readKey)).statusCode).toBe(403)
    expect((await keyCall('GET', '/api/api-keys', readKey)).statusCode).toBe(403)
    expect((await keyCall('POST', '/api/api-keys', readKey, { name: 'x', scopes: ['lists:read'] })).statusCode).toBe(403)
  })

  it('stops working once revoked', async () => {
    const created = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'temp', scopes: ['lists:read'] })).body)
    const key = created.key
    expect((await keyCall('GET', '/api/lists', key)).statusCode).toBe(200)
    expect((await call('DELETE', `/api/api-keys/${created.apiKey.id}`, kevin)).statusCode).toBe(204)
    expect((await keyCall('GET', '/api/lists', key)).statusCode).toBe(401)
  })

  it('rejects an expired key', async () => {
    const key = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'old', scopes: ['lists:read'], expiresAt: '2000-01-01T00:00:00Z' })).body).key
    expect((await keyCall('GET', '/api/lists', key)).statusCode).toBe(401)
  })
})

// Hyphenated sibling routes (/api/chore-instances, /api/goal-lists, …) belong to a resource
// that IS in the catalog, but `pathMatches` needs a `/` boundary, so each 403'd until its
// prefix was listed. Assert on the MESSAGE: a bare 403 passes either way.
describe('hyphenated sibling routes are reachable with the right scope', () => {
  const BOGUS = '00000000-0000-4000-8000-000000000000'
  let listsRead = ''
  let listsWrite = ''
  let goalsRead = ''
  let goalsWrite = ''
  let choresRead = ''
  let choresWrite = ''

  const msg = (res: { body: string }): string => JSON.parse(res.body).message as string

  beforeAll(async () => {
    const mintKey = async (name: string, scopes: string[]): Promise<string> =>
      JSON.parse((await call('POST', '/api/api-keys', kevin, { name, scopes })).body).key as string
    listsRead = await mintKey('lists-r', ['lists:read'])
    listsWrite = await mintKey('lists-w', ['lists:write'])
    goalsRead = await mintKey('goals-r', ['goals:read'])
    goalsWrite = await mintKey('goals-w', ['goals:write'])
    choresRead = await mintKey('chores-r', ['chores:read'])
    choresWrite = await mintKey('chores-w', ['chores:write'])
  })

  it('/api/pantry-staples answers to the lists scope (not pantry)', async () => {
    expect((await keyCall('GET', '/api/pantry-staples', listsRead)).statusCode).toBe(200)

    const wrong = await keyCall('GET', '/api/pantry-staples', goalsRead)
    expect(wrong.statusCode).toBe(403)
    expect(msg(wrong)).toMatch(/missing the required scope: lists:read/)

    const denied = await keyCall('POST', '/api/pantry-staples', listsRead, { name: 'Olive oil' })
    expect(denied.statusCode).toBe(403)
    expect(msg(denied)).toMatch(/missing the required scope: lists:write/)
    expect((await keyCall('POST', '/api/pantry-staples', listsWrite, { name: 'Olive oil' })).statusCode).toBe(201)

    expect((await keyCall('DELETE', `/api/pantry-staples/${BOGUS}`, listsWrite)).statusCode).toBe(404)
  })

  it('/api/goal-lists answers to the goals scope', async () => {
    expect((await keyCall('GET', '/api/goal-lists', goalsRead)).statusCode).toBe(200)

    const denied = await keyCall('POST', '/api/goal-lists', goalsRead, { name: 'Summer' })
    expect(denied.statusCode).toBe(403)
    expect(msg(denied)).toMatch(/missing the required scope: goals:write/)
    expect((await keyCall('POST', '/api/goal-lists', goalsWrite, { name: 'Summer' })).statusCode).toBe(201)
  })

  it('/api/chore-instances answers to the chores scope', async () => {
    expect((await keyCall('GET', '/api/chore-instances/today', choresRead)).statusCode).toBe(200)
    expect((await keyCall('GET', '/api/chore-instances/awaiting', choresRead)).statusCode).toBe(200)

    const denied = await keyCall('POST', `/api/chore-instances/${BOGUS}/complete`, choresRead)
    expect(denied.statusCode).toBe(403)
    expect(msg(denied)).toMatch(/missing the required scope: chores:write/)

    expect((await keyCall('POST', `/api/chore-instances/${BOGUS}/complete`, choresWrite)).statusCode).toBe(404)
  })

  it('/api/chore-proofs answers to the chores scope (admin-owned key)', async () => {
    // adminRoute is satisfiable by a key: apiKeyTenant carries the owner person's is_admin.
    expect((await keyCall('GET', '/api/chore-proofs', choresRead)).statusCode).toBe(200)

    const denied = await keyCall('DELETE', '/api/chore-proofs', choresRead)
    expect(denied.statusCode).toBe(403)
    expect(msg(denied)).toMatch(/missing the required scope: chores:write/)
    expect((await keyCall('DELETE', '/api/chore-proofs', choresWrite)).statusCode).toBe(200)
  })
})

// Currency conversions are half of the currencies surface and sit in the same file, but only
// /api/currencies was given to the `rewards` resource — so a key could manage the
// denominations and not the rates between them.
describe('currency conversions answer to the rewards scope', () => {
  const BOGUS = '00000000-0000-4000-8000-000000000000'
  let rewardsRead = ''
  let rewardsWrite = ''
  let otherKey = '' // a key for an unrelated resource

  const msg = (res: { body: string }): string => JSON.parse(res.body).message as string

  beforeAll(async () => {
    const mintKey = async (name: string, scopes: string[]): Promise<string> =>
      JSON.parse((await call('POST', '/api/api-keys', kevin, { name, scopes })).body).key as string
    rewardsRead = await mintKey('rewards-r', ['rewards:read'])
    rewardsWrite = await mintKey('rewards-w', ['rewards:write'])
    otherKey = await mintKey('photos-r', ['photos:read'])
    await call('POST', '/api/currencies', kevin, { label: 'Bucks', symbol: '💵' })
  })

  it('reads with rewards:read and writes only with rewards:write', async () => {
    expect((await keyCall('GET', '/api/conversions', rewardsRead)).statusCode).toBe(200)

    // An unrelated key is refused for a MISSING SCOPE, not as an unexposed path.
    const wrong = await keyCall('GET', '/api/conversions', otherKey)
    expect(wrong.statusCode).toBe(403)
    expect(msg(wrong)).toMatch(/missing the required scope: rewards:read/)

    const rate = { fromCurrency: 'stars', toCurrency: 'bucks', fromAmount: 10, toAmount: 1 }
    const denied = await keyCall('POST', '/api/conversions', rewardsRead, rate)
    expect(denied.statusCode).toBe(403)
    expect(msg(denied)).toMatch(/missing the required scope: rewards:write/)

    const created = await keyCall('POST', '/api/conversions', rewardsWrite, rate)
    expect(created.statusCode).toBe(201)
    expect(JSON.parse(created.body).conversion).toMatchObject({ fromCurrency: 'stars', toCurrency: 'bucks' })

    expect((await keyCall('DELETE', `/api/conversions/${BOGUS}`, rewardsWrite)).statusCode).toBe(404)
  })
})

// ── the catalog covers every live route, or the route says why not ──────────────
// The bug above was silent because nothing tied API_SCOPES to the route table. This walks
// lambda-api's own table, so it can't drift, and fails on any route that is neither
// scope-matched nor listed below.
//
// Adding a route family? Give its prefix to a resource in API_SCOPES, or list it in the
// bucket that tells the truth: NEVER_KEY_REACHABLE is a decision; UNSCOPED_YET is debt, and
// its `tracked` must name where that work lives. Both gate identically (absence is 403), so
// the split is for the reader. See docs/product/api-key-scopes-plan.md.
type NeverReachable = { why: string; prefixes: string[] }
type UnscopedYet = NeverReachable & { tracked: string }

const NEVER_KEY_REACHABLE: NeverReachable[] = [
  { why: 'public liveness probe', prefixes: ['/healthz'] },
  { why: 'echoes the token sub — tells a key nothing it does not already know', prefixes: ['/api/me'] },
  { why: 'login, OIDC, invites and self-service account are session-only', prefixes: ['/api/auth', '/auth', '/api/account', '/api/households'] },
  { why: 'a key can never mint or manage keys', prefixes: ['/api/api-keys'] },
  { why: 'kiosk and Waffled-Bite pairing run on their own device tokens', prefixes: ['/api/kiosk', '/api/waffled-bites'] },
  { why: 'the capability grid is an admin session surface', prefixes: ['/api/permissions'] },
  { why: 'offline sync is the first-party clients own transport', prefixes: ['/api/powersync'] },
  { why: 'LLM capture and the blob upload sink are first-party client surfaces', prefixes: ['/api/capture', '/api/media'] },
  { why: 'integrations surface — documented as always 403 for a key', prefixes: ['/api/countdowns', '/api/family-night', '/api/goal-calendar', '/api/calendar'] },
  { why: 'per-viewer UI layout, not household data', prefixes: ['/api/today-layout'] },
  { why: 'operator surfaces (deep health report, update channel)', prefixes: ['/api/health', '/api/updates'] },
]

const UNSCOPED_YET: UnscopedYet[] = [
  // The same boundary bug as /api/chore-instances. PR #180 adds the prefix, so this entry
  // only keeps the guard green until it lands.
  { why: 'a lists route that the /api/lists prefix cannot match', prefixes: ['/api/list-items'], tracked: 'PR #180' },
  { why: 'rhythms wants a whole new scope resource, not another prefix — nobody has designed it', prefixes: ['/api/rhythms'], tracked: 'docs/product/api-key-scopes-plan.md' },
  // Debt rather than a boundary, and the distinction is the point: a planning session WRITES
  // THROUGH to other modules, so with one scope per prefix a `weeklyPlanning` scope would be
  // a skeleton key past `chores:write` and the rest. Per-route, each asks for what it needs.
  { why: 'no correct scope exists under one-scope-per-prefix — a session writes through to chores/goals/events/meals', prefixes: ['/api/weekly-planning'], tracked: 'docs/product/api-key-scopes-plan.md' },
]

// Checked as one list: the buckets differ in what they claim, not in how they gate.
const NOT_KEY_REACHABLE: (NeverReachable | UnscopedYet)[] = [...NEVER_KEY_REACHABLE, ...UNSCOPED_YET]

describe('scope catalog covers the route table', () => {
  it('leaves no live route both unscoped and unlisted', async () => {
    const { scopeForRequest } = await import('../src/modules/api-keys/api-keys')
    const allowed = NOT_KEY_REACHABLE.flatMap((g) => g.prefixes)
    const covered = (path: string) => allowed.some((p) => path === p || path.startsWith(p + '/'))

    const orphans = (app.routes() as string[][])
      .map(([method, path]) => [method, path] as const)
      .filter(([method, path]) => !scopeForRequest(method, path) && !covered(path))
      .map(([method, path]) => `${method} ${path}`)

    expect(orphans).toEqual([])
  })

  // The test above passes a route with EITHER a scope OR an allowlist entry, so it cannot
  // notice an entry that has outlived its reason — one that gains a real scope drops out
  // while its entry sits here claiming a key is kept out. So assert the other direction too.
  it('has no stale allowlist entry — every listed prefix is still unscoped', async () => {
    const { scopeForRequest } = await import('../src/modules/api-keys/api-keys')
    const routes = (app.routes() as string[][]).map(([method, path]) => [method, path] as const)
    const under = (prefix: string, path: string) => path === prefix || path.startsWith(prefix + '/')

    const stale = NOT_KEY_REACHABLE.flatMap((entry) =>
      entry.prefixes
        .filter((prefix) => routes.some(([method, path]) => under(prefix, path) && scopeForRequest(method, path)))
        .map((prefix) =>
          'tracked' in entry
            ? `${prefix}: the work tracked at "${entry.tracked}" has landed and given this a scope — DELETE its entry (and the comment above it) from UNSCOPED_YET`
            : `${prefix}: now covered by API_SCOPES, so it is no longer excluded from anything — DELETE its entry from NEVER_KEY_REACHABLE`
        )
    )

    // Assert on the joined text: vitest collapses a long string inside an array to
    // "expected [ Array(1) ]", hiding the instruction this test exists to give.
    expect(stale.join('\n')).toBe('')
  })

  // A debt entry that doesn't say where the work lives is indistinguishable from a decision.
  it('every unscoped-yet entry names where its work is tracked', () => {
    const followable = /#\d+|docs\/[\w./-]+/
    const untracked = UNSCOPED_YET.filter((e) => !followable.test(e.tracked)).map(
      (e) =>
        `${e.prefixes.join(', ')}: tracked=${JSON.stringify(e.tracked)} — name a PR/issue (#123) or a docs/ path, or move it to NEVER_KEY_REACHABLE if it is really a decision`
    )
    expect(untracked.join('\n')).toBe('')
  })
})
