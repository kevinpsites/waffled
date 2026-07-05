// P2.5 of multi-household identity (docs/design/multi-household-identity.md §5.5):
// OIDC matches the verified email to an ACCOUNT (not just a person). A returning /
// existing account lands on its last-active household with an account-scoped token
// (sub = account.id + household claim), and the OIDC identity is linked to the
// account. A brand-new SSO email with a PENDING invite auto-creates an SSO-only
// account and accepts the invite (the "created on first sign-in, then auto-accepts"
// path). Same email across households = same account.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const HH_CLAIM = 'https://waffled.app/household_id'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

// ── stub IdP (compact) ──────────────────────────────────────────────────────────
let idp: Server
let issuer = ''
let privatePem = ''
const KID = 'stub-key'
const codes = new Map<string, { nonce: string }>()
let stubUser = { sub: 'idp-sub-1', email: 'kevin@example.com', email_verified: true }

function startIdp(publicKey: KeyObject): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jwk = publicKey.export({ format: 'jwk' }) as any
  jwk.kid = KID; jwk.alg = 'RS256'; jwk.use = 'sig'
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }))
    }
    if (url.pathname === '/jwks') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })) }
    if (url.pathname === '/authorize') {
      const nonce = url.searchParams.get('nonce') ?? ''
      const state = url.searchParams.get('state') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const code = 'code-' + randomUUID(); codes.set(code, { nonce })
      res.statusCode = 302; res.setHeader('location', `${redirectUri}?code=${code}&state=${state}`); return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => (body += c))
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? ''
        const entry = codes.get(code)
        if (!entry) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })) }
        codes.delete(code)
        const idToken = jwt.sign(
          { email: stubUser.email, email_verified: stubUser.email_verified, nonce: entry.nonce },
          privatePem, { algorithm: 'RS256', keyid: KID, issuer, audience: 'waffled-client', subject: stubUser.sub, expiresIn: 300 }
        )
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer', access_token: 'stub' }))
      })
      return
    }
    res.statusCode = 404; res.end()
  })
  return new Promise((resolve) => { idp.listen(0, '127.0.0.1', () => { issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`; resolve() }) })
}

interface RunResult { statusCode: number; headers: Record<string, string>; body: string }
function call(method: string, path: string, opts: { body?: unknown; token?: string; query?: Record<string, string> } = {}): Promise<RunResult> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: opts.query ?? {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)
const loc = (r: RunResult) => r.headers.location ?? r.headers.Location ?? ''
const decode = (t: string) => jwt.decode(t) as { sub: string; [k: string]: unknown }

// Drive /start → stub /authorize → /callback, returning the handoff redirect.
async function ssoCallback(redirect = 'http://localhost:8080/'): Promise<RunResult> {
  const start = await call('GET', '/api/auth/oidc/start', { query: { redirect } })
  const authorizeUrl = new URL(loc(start))
  const state = authorizeUrl.searchParams.get('state')!
  const authRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' })
  const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!
  return call('GET', '/api/auth/oidc/callback', { query: { code, state } })
}
// Full login → returns the exchanged session.
async function ssoLogin(redirect?: string) {
  const cb = await ssoCallback(redirect)
  expect(cb.statusCode).toBe(302)
  const handoff = new URL(loc(cb)).searchParams.get('code')!
  const ex = await call('POST', '/api/auth/oidc/exchange', { body: { code: handoff } })
  expect(ex.statusCode).toBe(200)
  return json(ex)
}

let kevinAccountId = ''
let householdA = ''
let householdB = ''
let adminToken = ''

beforeAll(async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  await startIdp(publicKey)

  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.LOCAL_JWT_SECRET = 'waffled-local-dev-secret-change-me'
  delete process.env.AUTH0_DOMAIN
  delete process.env.AUTH_FORCE_PASSWORD
  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))

  // Household A + owner Kevin; enable OIDC.
  const setup = await call('POST', '/api/auth/setup', { body: { household: { name: 'A', timezone: 'America/Chicago' }, admin: { name: 'Kevin', email: 'kevin@example.com', password: 'hunter2hunter' } } })
  expect(setup.statusCode).toBe(201)
  adminToken = json(setup).accessToken
  kevinAccountId = (await query(`select id from accounts where lower(email)='kevin@example.com' and deleted_at is null`)).rows[0].id
  householdA = (await query(`select household_id from persons where name='Kevin'`)).rows[0].household_id
  await call('PUT', '/api/auth/config', { token: adminToken, body: { oidcEnabled: true, issuerUrl: issuer, clientId: 'waffled-client', clientSecret: 'shh', buttonLabel: 'Sign in with Acme' } })

  // Give Kevin a second membership in household B.
  householdB = (await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)).rows[0].id
  await query(`insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'KevinB','adult',true,$2)`, [householdB, kevinAccountId])
}, 120_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
  await new Promise<void>((r) => idp.close(() => r()))
})

describe('P2.5 OIDC match-by-account', () => {
  it('existing account SSO → account-scoped token landing on last-active; identity linked to account', async () => {
    await query(`update accounts set last_household_id=$1 where id=$2`, [householdA, kevinAccountId])
    stubUser = { sub: 'idp-kevin', email: 'kevin@example.com', email_verified: true }
    const session = await ssoLogin()

    const claims = decode(session.accessToken)
    expect(claims.sub).toBe(kevinAccountId)
    expect(claims[HH_CLAIM]).toBe(householdA)
    expect(json(await call('GET', '/api/household', { token: session.accessToken })).household.name).toBe('A')
    // memberships are returned for the switcher
    expect(session.memberships.map((m: { householdId: string }) => m.householdId).sort()).toEqual([householdA, householdB].sort())
    // the OIDC identity is linked to the account
    const ident = await query(`select account_id from identities where provider='oidc' and email='kevin@example.com'`)
    expect(ident.rows[0].account_id).toBe(kevinAccountId)
  })

  it('the same account lands on household B when it is last-active', async () => {
    await query(`update accounts set last_household_id=$1 where id=$2`, [householdB, kevinAccountId])
    stubUser = { sub: 'idp-kevin', email: 'kevin@example.com', email_verified: true }
    const session = await ssoLogin()
    expect(decode(session.accessToken)[HH_CLAIM]).toBe(householdB)
    expect(json(await call('GET', '/api/household', { token: session.accessToken })).household.name).toBe('B')
  })

  it('brand-new SSO email with a pending invite → auto-creates an SSO account and accepts', async () => {
    // Admin invites an email that has NO account and NO person yet.
    const inv = await call('POST', '/api/households/invites', { token: adminToken, body: { email: 'grace@example.com', memberType: 'adult', isAdmin: false } })
    expect(inv.statusCode).toBe(201)

    stubUser = { sub: 'idp-grace', email: 'grace@example.com', email_verified: true }
    const session = await ssoLogin()

    // an SSO-only account now exists (no password) and resolves to household A
    const acct = await query(`select id, password_hash from accounts where lower(email)='grace@example.com' and deleted_at is null`)
    expect(acct.rows).toHaveLength(1)
    expect(acct.rows[0].password_hash).toBeNull()
    const graceAccountId = acct.rows[0].id

    const claims = decode(session.accessToken)
    expect(claims.sub).toBe(graceAccountId)
    expect(claims[HH_CLAIM]).toBe(householdA)
    expect(json(await call('GET', '/api/household', { token: session.accessToken })).household.name).toBe('A')

    // a membership was created in A, linked to the account, and the invite is consumed
    const member = await query(`select id, account_id from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, graceAccountId])
    expect(member.rows).toHaveLength(1)
    const consumed = await query(`select accepted_at from household_invites where lower(email)='grace@example.com'`)
    expect(consumed.rows[0].accepted_at).not.toBeNull()
    // the oidc identity is linked to grace's account
    const ident = await query(`select account_id from identities where provider='oidc' and email='grace@example.com'`)
    expect(ident.rows[0].account_id).toBe(graceAccountId)
  })

  it('an uninvited, unknown SSO email is still rejected (403)', async () => {
    stubUser = { sub: 'idp-stranger', email: 'stranger@example.com', email_verified: true }
    const cb = await ssoCallback()
    expect(cb.statusCode).toBe(403)
    expect(cb.body).toContain('Not invited')
  })
})
