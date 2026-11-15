// The OAuth 2.1 authorization server for MCP connectors (docs/product/mcp-plan.md §4):
// consent (driven by the web SPA at /oauth/authorize), the token endpoint, the grant list
// behind Settings → Connected apps, and the per-call check a grant token gets on /mcp.
// Sign-in itself is the ordinary Waffled login; this only adds consent on top of it.
import { createHash, randomBytes } from 'node:crypto'
import createAPI, { type Request, type Response } from 'lambda-api'
import { query, getPool } from '../../platform/db'
import { AuthError } from '../../platform/auth'
import { can } from '../../platform/permissions'
import { requireTenant, type Tenant } from '../households/households'
import { listMemberships } from '../auth/accounts'
import { sha256 } from '../auth/auth'
import { ClientError, markClientUsed, redirectAllowed, resolveClient, type OAuthClient } from './clients'
import { canonicalResource, issuerUrl, mcpResource, mcpScopes, SCOPE_DESCRIPTIONS } from './metadata'
import { claimsGrant, mintMcpAccess, verifyMcpAccess } from './tokens'

type Api = ReturnType<typeof createAPI>

declare module 'lambda-api' {
  interface Request {
    mcpGrant?: { id: string; clientId: string; scopes: string[]; tenant: Tenant }
  }
}

const CODE_TTL_SECONDS = 60
// A rotated refresh token presented again this soon is taken for a client racing itself
// (Claude refreshes both proactively and on a 401), not a theft: refused, not revoked.
const REFRESH_REUSE_GRACE_SECONDS = 30
const REFRESH_TTL_DAYS = Number(process.env.MCP_REFRESH_TOKEN_TTL_DAYS) || 30
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Claude appends offline_access when a server lists it; we always issue a refresh token,
// so it is accepted and dropped rather than refused.
const IGNORED_SCOPES = new Set(['offline_access'])

// ── the authorization request ──────────────────────────────────────────────────

interface AuthorizeRequest {
  client: OAuthClient
  redirectUri: string
  state: string | null
  codeChallenge: string
  resource: string
  scopes: string[]
}

// An error the client should see. `redirect` is set only once client and redirect_uri are
// known good: an unverified redirect_uri is never followed (it would be an open redirect).
interface AuthorizeError {
  error: string
  description: string
  redirect?: string
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v)
  return u.toString()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

async function validateAuthorize(req: Request, p: Record<string, unknown>): Promise<AuthorizeRequest | AuthorizeError> {
  let client: OAuthClient
  try {
    client = await resolveClient(str(p.client_id))
  } catch (err) {
    if (err instanceof ClientError) return { error: 'invalid_client', description: err.message }
    throw err
  }
  const redirectUri = str(p.redirect_uri)
  if (!redirectAllowed(client.redirectUris, redirectUri)) {
    return { error: 'invalid_request', description: 'redirect_uri is not registered for this client' }
  }
  const state = typeof p.state === 'string' ? p.state : null
  const fail = (error: string, description: string): AuthorizeError => ({
    error,
    description,
    redirect: withParams(redirectUri, { error, error_description: description, state, iss: issuerUrl(req) }),
  })

  if (p.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code')
  const codeChallenge = str(p.code_challenge)
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return fail('invalid_request', 'a code_challenge is required (PKCE)')
  if (p.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256')

  const ours = mcpResource(req)
  const asked = p.resource === undefined || p.resource === '' ? ours : canonicalResource(str(p.resource))
  if (asked !== ours) return fail('invalid_target', `resource must be ${ours}`)

  const offered = mcpScopes()
  const requested = str(p.scope).split(/\s+/).filter((s) => s && !IGNORED_SCOPES.has(s))
  const scopes = requested.length ? [...new Set(requested)] : offered
  const unknown = scopes.filter((s) => !offered.includes(s))
  if (unknown.length) return fail('invalid_scope', `unknown or unavailable scope(s): ${unknown.join(' ')}`)

  return { client, redirectUri, state, codeChallenge, resource: ours, scopes }
}

function isError(v: AuthorizeRequest | AuthorizeError): v is AuthorizeError {
  return 'error' in v
}

// The account behind a normal user session. A kiosk or device session has none and can
// never approve a connector.
async function sessionAccount(req: Request): Promise<{ tenant: Tenant; accountId: string | null }> {
  const tenant = await requireTenant(req)
  if (req.apiKey || req.mcpGrant) throw new AuthError('Sign in to Waffled to connect an app', 403)
  const claims = req.principal?.claims ?? {}
  if (claims.kind === 'device' || tenant.sub.startsWith('kiosk:')) return { tenant, accountId: null }
  const { rows } = await query<{ account_id: string | null }>(`select account_id from persons where id = $1`, [tenant.personId])
  return { tenant, accountId: rows[0]?.account_id ?? null }
}

async function householdSettings(ids: string[]): Promise<Map<string, unknown>> {
  if (!ids.length) return new Map()
  const { rows } = await query<{ id: string; settings: unknown }>(`select id, settings from households where id = any($1)`, [ids])
  return new Map(rows.map((r) => [r.id, r.settings]))
}

async function connectableHouseholds(accountId: string | null) {
  if (!accountId) return []
  const memberships = await listMemberships(accountId)
  const settings = await householdSettings(memberships.map((m) => m.householdId))
  return memberships.map((m) => ({
    id: m.householdId,
    name: m.householdName,
    personId: m.personId,
    canConnect: can(m.memberType, m.isAdmin, 'ai.connect', settings.get(m.householdId)),
  }))
}

// ── the token endpoint ─────────────────────────────────────────────────────────

function tokenError(res: Response, error: string, description: string, status = 400) {
  return res.status(status).header('Cache-Control', 'no-store').header('Pragma', 'no-cache').json({ error, error_description: description })
}

interface LiveGrant {
  id: string
  householdId: string
  personId: string
  accountId: string
  clientId: string
  resource: string
  scopes: string[]
  isAdmin: boolean
  memberType: string
}

// A grant that may still be used right now: unrevoked, its person still in the household
// with a sign-in, and still holding ai.connect.
async function liveGrant(grantId: string): Promise<LiveGrant | null> {
  const { rows } = await query<{
    id: string
    household_id: string
    person_id: string
    account_id: string | null
    client_id: string
    resource: string
    scopes: string[]
    is_admin: boolean
    member_type: string
    settings: unknown
  }>(
    `select g.id, g.household_id, g.person_id, p.account_id, g.client_id, g.resource, g.scopes,
            p.is_admin, p.member_type, h.settings
       from oauth_grants g
       join persons p on p.household_id = g.household_id and p.id = g.person_id and p.deleted_at is null
       join households h on h.id = g.household_id and h.deleted_at is null
      where g.id = $1 and g.revoked_at is null`,
    [grantId]
  )
  const r = rows[0]
  if (!r || !r.account_id) return null
  if (!can(r.member_type, r.is_admin, 'ai.connect', r.settings)) return null
  return {
    id: r.id,
    householdId: r.household_id,
    personId: r.person_id,
    accountId: r.account_id,
    clientId: r.client_id,
    resource: r.resource,
    scopes: r.scopes,
    isAdmin: r.is_admin,
    memberType: r.member_type,
  }
}

async function revokeGrant(grantId: string): Promise<void> {
  await query(`update oauth_grants set revoked_at = now() where id = $1 and revoked_at is null`, [grantId])
  await query(`delete from oauth_refresh_tokens where grant_id = $1`, [grantId])
}

async function issueTokens(res: Response, grant: LiveGrant, scopes: string[]) {
  const access = mintMcpAccess({
    accountId: grant.accountId,
    householdId: grant.householdId,
    resource: grant.resource,
    scopes,
    grantId: grant.id,
    clientId: grant.clientId,
  })
  const refreshToken = randomBytes(32).toString('base64url')
  // Spent tokens stay until they expire, so a replay is still recognised as one.
  await query(`delete from oauth_refresh_tokens where grant_id = $1 and expires_at < now()`, [grant.id])
  await query(
    `insert into oauth_refresh_tokens (grant_id, token_hash, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
    [grant.id, sha256(refreshToken), String(REFRESH_TTL_DAYS)]
  )
  await query(`update oauth_grants set last_used_at = now() where id = $1`, [grant.id])
  return res
    .status(200)
    .header('Cache-Control', 'no-store')
    .header('Pragma', 'no-cache')
    .json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token: refreshToken, scope: scopes.join(' ') })
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

function resourceMismatch(body: Record<string, string>, expected: string): boolean {
  return body.resource !== undefined && body.resource !== '' && canonicalResource(body.resource) !== expected
}

async function authorizationCodeGrant(body: Record<string, string>, res: Response) {
  const code = body.code
  if (!code || !body.code_verifier || !body.client_id || !body.redirect_uri) {
    return tokenError(res, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required')
  }
  const hash = sha256(code)
  const { rows } = await query<{
    grant_id: string
    client_id: string
    redirect_uri: string
    code_challenge: string
    resource: string
    consumed: boolean
    expired: boolean
  }>(
    `select grant_id, client_id, redirect_uri, code_challenge, resource,
            consumed_at is not null as consumed, expires_at <= now() as expired
       from oauth_codes where code_hash = $1`,
    [hash]
  )
  const c = rows[0]
  if (!c) return tokenError(res, 'invalid_grant', 'The authorization code is invalid or was already used')
  // Nothing is spent or revoked until the caller proves it is the client that asked: a
  // leaked code alone must not be able to burn a code or kill a grant.
  if (c.client_id !== body.client_id || c.redirect_uri !== body.redirect_uri) {
    return tokenError(res, 'invalid_grant', 'client_id or redirect_uri does not match the authorization request')
  }
  if (!pkceMatches(body.code_verifier, c.code_challenge)) return tokenError(res, 'invalid_grant', 'PKCE verification failed')
  const replayed = async () => {
    // A second use of a code means it leaked; OAuth 2.1 §4.1.3 says kill what it issued.
    await revokeGrant(c.grant_id)
    return tokenError(res, 'invalid_grant', 'The authorization code is invalid or was already used')
  }
  if (c.consumed) return replayed()
  if (c.expired) return tokenError(res, 'invalid_grant', 'The authorization code has expired')
  if (resourceMismatch(body, c.resource)) return tokenError(res, 'invalid_target', `resource must be ${c.resource}`)
  const consumed = await query(`update oauth_codes set consumed_at = now() where code_hash = $1 and consumed_at is null`, [hash])
  if (!consumed.rowCount) return replayed()

  const grant = await liveGrant(c.grant_id)
  if (!grant) return tokenError(res, 'invalid_grant', 'This connection is no longer allowed')
  return issueTokens(res, grant, grant.scopes)
}

async function refreshTokenGrant(body: Record<string, string>, res: Response) {
  const token = body.refresh_token
  if (!token || !body.client_id) return tokenError(res, 'invalid_request', 'refresh_token and client_id are required')
  const hash = sha256(token)
  const { rows } = await query<{ grant_id: string; used: boolean; recently_used: boolean; expired: boolean }>(
    `select grant_id, used_at is not null as used, expires_at <= now() as expired,
            used_at > now() - ($2 || ' seconds')::interval as recently_used
       from oauth_refresh_tokens where token_hash = $1`,
    [hash, String(REFRESH_REUSE_GRACE_SECONDS)]
  )
  const t = rows[0]
  const refused = () => tokenError(res, 'invalid_grant', 'The refresh token is invalid, expired or was already used')
  if (!t || t.expired) return refused()
  if (t.used) {
    if (!t.recently_used) await revokeGrant(t.grant_id)
    return refused()
  }
  const grant = await liveGrant(t.grant_id)
  if (!grant || grant.clientId !== body.client_id) return tokenError(res, 'invalid_grant', 'This connection is no longer allowed')
  if (resourceMismatch(body, grant.resource)) return tokenError(res, 'invalid_target', `resource must be ${grant.resource}`)

  let scopes = grant.scopes
  const asked = (body.scope ?? '').split(/\s+/).filter((s) => s && !IGNORED_SCOPES.has(s))
  if (asked.length) {
    if (!asked.every((s) => grant.scopes.includes(s))) return tokenError(res, 'invalid_scope', 'A refresh cannot widen the granted scopes')
    scopes = asked
  }
  // Spent only once every check passed. Of two concurrent refreshes one wins this update;
  // the loser is inside the grace window by definition.
  const spent = await query(`update oauth_refresh_tokens set used_at = now() where token_hash = $1 and used_at is null`, [hash])
  if (!spent.rowCount) return refused()
  return issueTokens(res, grant, scopes)
}

// ── /mcp: the per-call check for a grant token ─────────────────────────────────

export { claimsGrant }

// Verifies a grant token for /mcp and re-checks the grant itself on every call, so a
// revoke or a lost ai.connect takes effect on the next request. Any failure is a 401,
// which sends the client back through refresh (now refused) and re-consent.
export async function authenticateMcpGrant(req: Request, token: string): Promise<void> {
  const claims = verifyMcpAccess(token, mcpResource(req))
  const grant = await liveGrant(claims.grant_id)
  if (!grant || grant.accountId !== claims.sub) throw new AuthError('Invalid token: this connection was revoked')
  const scopes = claims.scope.split(' ').filter((s) => grant.scopes.includes(s))
  req.principal = { sub: claims.sub, claims }
  req.mcpGrant = {
    id: grant.id,
    clientId: grant.clientId,
    scopes,
    tenant: { sub: claims.sub, personId: grant.personId, householdId: grant.householdId, isAdmin: grant.isAdmin, memberType: grant.memberType },
  }
  await query(
    `update oauth_grants set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [grant.id]
  )
}

// ── routes ─────────────────────────────────────────────────────────────────────

interface GrantRow {
  id: string
  client_id: string
  client_name: string
  redirect_uri: string
  scopes: string[]
  household_id: string
  household_name: string
  created_at: Date
  last_used_at: Date | null
}

// A session sees the grants of its account (any household it belongs to — consent may
// pick a household other than the active one). Like consent, it needs a real account: a
// kiosk or device session must not see or revoke a member's connections.
async function ownAccountId(req: Request): Promise<string> {
  const { accountId } = await sessionAccount(req)
  if (!accountId) throw new AuthError('This session has no Waffled account', 403)
  return accountId
}

export function registerOAuthRoutes(api: Api): void {
  // The consent screen's data. Authenticated: the SPA shows its login first.
  api.get('/api/oauth/authorize/info', async (req: Request, res: Response) => {
    const v = await validateAuthorize(req, req.query as Record<string, unknown>)
    if (isError(v)) return res.status(400).json({ error: v.error, error_description: v.description, ...(v.redirect ? { redirect: v.redirect } : {}) })
    const { accountId } = await sessionAccount(req)
    const households = await connectableHouseholds(accountId)
    return {
      client: { id: v.client.clientId, name: v.client.clientName, redirectHost: new URL(v.redirectUri).host },
      scopes: v.scopes.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] ?? scope, write: scope.endsWith(':write') })),
      households: households.map(({ id, name, canConnect }) => ({ id, name, canConnect })),
    }
  })

  // Approve or cancel. Answers the URL to send the browser to; the SPA navigates there.
  api.post('/api/oauth/authorize', async (req: Request, res: Response) => {
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
    const v = await validateAuthorize(req, body)
    if (isError(v)) return res.status(400).json({ error: v.error, error_description: v.description, ...(v.redirect ? { redirect: v.redirect } : {}) })
    const { accountId } = await sessionAccount(req)

    if (body.decision !== 'approve') {
      return { redirect: withParams(v.redirectUri, { error: 'access_denied', error_description: 'The request was declined', state: v.state, iss: issuerUrl(req) }) }
    }
    if (!accountId) throw new AuthError('This session has no Waffled account', 403)
    const household = (await connectableHouseholds(accountId)).find((m) => m.id === body.householdId)
    if (!household) throw new AuthError('Not a member of that household', 403)
    if (!household.canConnect) throw new AuthError('You do not have permission to connect AI apps in this household', 403)

    const granted = Array.isArray(body.scopes) ? [...new Set(body.scopes.map(String))] : []
    if (!granted.length || !granted.every((s) => v.scopes.includes(s))) {
      return res.status(400).json({ error: 'BadRequest', message: 'Choose at least one of the requested scopes' })
    }

    const code = randomBytes(32).toString('base64url')
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const g = await client.query<{ id: string }>(
        `insert into oauth_grants (household_id, person_id, client_id, client_name, redirect_uri, resource, scopes)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [household.id, household.personId, v.client.clientId, v.client.clientName, v.redirectUri, v.resource, granted]
      )
      await client.query(
        `insert into oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
        [sha256(code), g.rows[0].id, v.client.clientId, v.redirectUri, v.codeChallenge, v.resource, String(CODE_TTL_SECONDS)]
      )
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
    if (v.client.kind === 'registered') await markClientUsed(v.client.clientId)
    // Codes are worthless a minute after issue; sweep them, and grants never exchanged.
    await query(`delete from oauth_codes where expires_at < now() - interval '1 day'`)
    await query(
      `delete from oauth_grants g where g.last_used_at is null and g.created_at < now() - interval '1 day'
          and not exists (select 1 from oauth_refresh_tokens t where t.grant_id = g.id)`
    )
    return { redirect: withParams(v.redirectUri, { code, state: v.state, iss: issuerUrl(req) }) }
  })

  // PUBLIC — form-encoded, per RFC 6749. lambda-api parses the urlencoded body.
  api.post('/api/oauth/token', async (req: Request, res: Response) => {
    const raw = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {}
    const body: Record<string, string> = {}
    for (const [k, val] of Object.entries(raw)) if (typeof val === 'string') body[k] = val
    if (body.grant_type === 'authorization_code') return authorizationCodeGrant(body, res)
    if (body.grant_type === 'refresh_token') return refreshTokenGrant(body, res)
    return tokenError(res, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  })

  api.get('/api/oauth/grants', async (req: Request) => {
    const accountId = await ownAccountId(req)
    const { rows } = await query<GrantRow>(
      `select g.id, g.client_id, g.client_name, g.redirect_uri, g.scopes, g.household_id, h.name as household_name,
              g.created_at, g.last_used_at
         from oauth_grants g
         join persons p on p.household_id = g.household_id and p.id = g.person_id
         join households h on h.id = g.household_id
        where p.account_id = $1 and g.revoked_at is null
          and exists (select 1 from oauth_refresh_tokens t where t.grant_id = g.id)
        order by g.created_at desc`,
      [accountId]
    )
    return {
      grants: rows.map((r) => ({
        id: r.id,
        clientId: r.client_id,
        clientName: r.client_name,
        redirectHost: new URL(r.redirect_uri).host,
        scopes: r.scopes,
        householdId: r.household_id,
        householdName: r.household_name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      })),
      scopeDescriptions: SCOPE_DESCRIPTIONS,
    }
  })

  api.delete('/api/oauth/grants/:id', async (req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'connection not found' })
    const accountId = await ownAccountId(req)
    const { rows } = await query<{ id: string }>(
      `select g.id from oauth_grants g
         join persons p on p.household_id = g.household_id and p.id = g.person_id
        where p.account_id = $1 and g.id = $2 and g.revoked_at is null`,
      [accountId, id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'NotFound', message: 'connection not found' })
    await revokeGrant(id)
    return res.status(204).send('')
  })
}
