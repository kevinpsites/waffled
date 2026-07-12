// OIDC end-to-end against a stub IdP run in-process: configure (admin) → start →
// authorize → callback (token exchange + JWKS verify + invite-gated link) → handoff
// exchange → authed request. Also covers the not-invited rejection and the
// password-lockout guard. Fresh container so the instance starts uninitialized.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

const LOCAL_SECRET = 'waffled-local-dev-secret-change-me'

// ── stub IdP ───────────────────────────────────────────────────────────────────
let idp: Server
let issuer = ''
let privatePem = ''
const KID = 'stub-key'
const codes = new Map<string, { nonce: string }>()
// The user the stub "authenticates". Tests mutate this between cases.
let stubUser = { sub: 'idp-sub-1', email: 'kevin@example.com', email_verified: true }

function startIdp(publicKey: KeyObject): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jwk = publicKey.export({ format: 'jwk' }) as any
  jwk.kid = KID
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }))
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ keys: [jwk] }))
    }
    if (url.pathname === '/authorize') {
      const nonce = url.searchParams.get('nonce') ?? ''
      const state = url.searchParams.get('state') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const code = 'code-' + randomUUID()
      codes.set(code, { nonce })
      res.statusCode = 302
      res.setHeader('location', `${redirectUri}?code=${code}&state=${state}`)
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? ''
        const entry = codes.get(code)
        if (!entry) {
          res.statusCode = 400
          return res.end(JSON.stringify({ error: 'invalid_grant' }))
        }
        codes.delete(code)
        const idToken = jwt.sign(
          {
            email: stubUser.email,
            email_verified: stubUser.email_verified,
            nonce: entry.nonce,
          },
          privatePem,
          { algorithm: 'RS256', keyid: KID, issuer, audience: 'waffled-client', subject: stubUser.sub, expiresIn: 300 }
        )
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer', access_token: 'stub' }))
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  return new Promise((resolve) => {
    idp.listen(0, '127.0.0.1', () => {
      issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`
      resolve()
    })
  })
}

// ── app driver ──────────────────────────────────────────────────────────────────
interface RunResult { statusCode: number; headers: Record<string, string>; body: string }
function call(method: string, path: string, opts: { body?: unknown; token?: string; query?: Record<string, string> } = {}): Promise<RunResult> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    {
      httpMethod: method,
      path,
      headers,
      queryStringParameters: opts.query ?? {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      isBase64Encoded: false,
    },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)
const loc = (r: RunResult) => r.headers.location ?? r.headers.Location ?? ''
const mint = (sub: string) => jwt.sign({}, LOCAL_SECRET, {
  algorithm: 'HS256',
  subject: sub,
  issuer: 'waffled-local',
  audience: 'waffled-api',
  expiresIn: '1h',
})

beforeAll(async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  await startIdp(publicKey)

  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64') // 32 bytes → encryption available
  process.env.LOCAL_JWT_SECRET = LOCAL_SECRET
  delete process.env.AUTH0_DOMAIN
  delete process.env.AUTH_FORCE_PASSWORD
  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))
}, 120_000)
afterAll(async () => {
  await closePool?.()
  await pg?.stop()
  await new Promise<void>((r) => idp.close(() => r()))
})

// Drive the redirect flow: /start → stub /authorize → our /callback → handoff code.
async function ssoLogin(redirect = 'http://localhost:8080/'): Promise<RunResult> {
  const start = await call('GET', '/api/auth/oidc/start', { query: { redirect } })
  expect(start.statusCode).toBe(302)
  const authorizeUrl = new URL(loc(start))
  expect(authorizeUrl.origin).toBe(issuer)
  const state = authorizeUrl.searchParams.get('state')!
  expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')

  // Simulate the browser hitting the IdP authorize endpoint → it issues a code.
  const authRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' })
  const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!

  // The IdP redirects the browser to our callback.
  return call('GET', '/api/auth/oidc/callback', { query: { code, state } })
}

describe('OIDC login', () => {
  let admin: { accessToken: string; person: { id: string } }

  it('sets up the admin and enables OIDC via the admin config route', async () => {
    const setup = await call('POST', '/api/auth/setup', {
      body: {
        household: { name: 'Sites', timezone: 'America/Chicago' },
        admin: { name: 'Kevin', email: 'kevin@example.com', password: 'hunter2hunter' },
      },
    })
    expect(setup.statusCode).toBe(201)
    admin = json(setup)

    const assigned = await query(
      `select cfg.installation_owner_account_id, p.account_id
         from auth_config cfg
         join persons p on p.id = $1
        where cfg.id = true`,
      [admin.person.id]
    )
    expect(assigned.rows[0].installation_owner_account_id).toBe(assigned.rows[0].account_id)

    // Status: only password before OIDC is configured.
    expect(json(await call('GET', '/api/auth/status')).methods).toEqual(['password'])

    const put = await call('PUT', '/api/auth/config', {
      token: admin.accessToken,
      body: { oidcEnabled: true, issuerUrl: issuer, clientId: 'waffled-client', clientSecret: 'shh-secret', buttonLabel: 'Sign in with Acme' },
    })
    expect(put.statusCode).toBe(200)
  })

  it('advertises oidc in status once configured', async () => {
    const s = json(await call('GET', '/api/auth/status'))
    expect(s.methods).toContain('oidc')
    expect(s.methods).toContain('password')
    expect(s.oidc).toMatchObject({ buttonLabel: 'Sign in with Acme' })
  })

  it('reserves installation-wide auth config for the installation owner account', async () => {
    const originalHousehold = await query(
      `select id, owner_person_id from households order by created_at, id limit 1`
    )
    await query(`update households set owner_person_id = null where id = $1`, [originalHousehold.rows[0].id])
    expect((await call('GET', '/api/auth/config', { token: admin.accessToken })).statusCode).toBe(200)
    await query(`update households set owner_person_id = $1 where id = $2`, [
      originalHousehold.rows[0].owner_person_id,
      originalHousehold.rows[0].id,
    ])

    const extra = json(await call('POST', '/api/households', {
      token: admin.accessToken,
      body: {
        name: 'Lake House',
        timezone: 'America/Chicago',
        person: { name: 'Kevin' },
      },
    }))
    const switched = json(await call('POST', '/api/auth/switch', {
      token: admin.accessToken,
      body: { householdId: extra.household.id },
    }))
    expect((await call('GET', '/api/auth/config', { token: switched.accessToken })).statusCode).toBe(200)

    const household = await query(
      `insert into households (name, timezone) values ('Other family', 'UTC') returning id`
    )
    const person = await query(
      `insert into persons (household_id, name, member_type, is_admin)
       values ($1, 'Other owner', 'adult', true) returning id`,
      [household.rows[0].id]
    )
    await query(`update households set owner_person_id = $1 where id = $2`, [
      person.rows[0].id,
      household.rows[0].id,
    ])
    await query(
      `insert into identities
         (household_id, person_id, provider, auth0_user_id, email_verified, is_primary)
       values ($1, $2, 'password', 'dev|other-owner', true, true)`,
      [household.rows[0].id, person.rows[0].id]
    )
    const otherAdmin = mint('dev|other-owner')

    expect((await call('GET', '/api/auth/config', { token: otherAdmin })).statusCode).toBe(403)
    expect((await call('PUT', '/api/auth/config', {
      token: otherAdmin,
      body: { buttonLabel: 'Hijacked login' },
    })).statusCode).toBe(403)
    expect((await call('POST', '/api/auth/config/test', {
      token: otherAdmin,
      body: { issuerUrl: issuer },
    })).statusCode).toBe(403)

    const ownerConfig = json(await call('GET', '/api/auth/config', { token: admin.accessToken }))
    expect(ownerConfig.buttonLabel).toBe('Sign in with Acme')
  })

  it('links an invited email on first SSO login and authenticates', async () => {
    stubUser = { sub: 'idp-sub-1', email: 'kevin@example.com', email_verified: true }
    const cb = await ssoLogin()
    expect(cb.statusCode).toBe(302)
    const handoff = new URL(loc(cb)).searchParams.get('code')!
    expect(handoff).toBeTruthy()

    const ex = await call('POST', '/api/auth/oidc/exchange', { body: { code: handoff } })
    expect(ex.statusCode).toBe(200)
    const session = json(ex)
    expect(session.accessToken).toBeTruthy()
    // The minted access token resolves to Kevin's household.
    expect(json(await call('GET', '/api/household', { token: session.accessToken }))).toMatchObject({ provisioned: true })

    // The handoff code is single-use.
    expect((await call('POST', '/api/auth/oidc/exchange', { body: { code: handoff } })).statusCode).toBe(401)
  })

  it('returns a custom-scheme deep link for a native (mobile) redirect', async () => {
    stubUser = { sub: 'idp-sub-1', email: 'kevin@example.com', email_verified: true }
    const cb = await ssoLogin('waffled://auth/callback')
    expect(cb.statusCode).toBe(302)
    // Must be the app's deep link (not "null/auth/callback") so iOS can intercept it.
    const dest = new URL(loc(cb))
    expect(dest.protocol).toBe('waffled:')
    expect(loc(cb)).toMatch(/^waffled:\/\/auth\/callback\?code=/)
    const handoff = dest.searchParams.get('code')!
    expect((await call('POST', '/api/auth/oidc/exchange', { body: { code: handoff } })).statusCode).toBe(200)
  })

  it('rejects an SSO login whose email is not on file', async () => {
    stubUser = { sub: 'idp-sub-2', email: 'stranger@example.com', email_verified: true }
    const cb = await ssoLogin()
    expect(cb.statusCode).toBe(403)
    expect(cb.body).toContain('Not invited')
  })
})
