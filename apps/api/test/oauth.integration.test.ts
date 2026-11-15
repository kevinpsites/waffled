// OAuth 2.1 for MCP connectors (docs/product/mcp-plan.md §4): discovery metadata, client
// registration (DCR + Client ID Metadata Documents), consent, the token endpoint, the /mcp
// verify path for grant tokens, and revocation — all through real routes on a throwaway
// Postgres.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { startMcpHarness, bearer, json, header, type McpHarness, type RunResult } from './helpers/mcp'

let h: McpHarness
let session = '' // Kevin's account-scoped session, from a real password login
let teenSession = ''
let teenId = ''

const HOST = { 'x-forwarded-host': 'waffled.example', 'x-forwarded-proto': 'https' }
const ORIGIN = 'https://waffled.example'
const RESOURCE = `${ORIGIN}/mcp`
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

const b64url = (b: Buffer) => b.toString('base64url')
function pkce() {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

function get(path: string, headers: Record<string, string> = {}, qs: Record<string, string> = {}) {
  return h.run('GET', path, { ...HOST, ...headers }, undefined, undefined, qs)
}
function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return h.run('POST', path, { ...HOST, ...headers }, body)
}
function postForm(path: string, form: Record<string, string>) {
  return h.run('POST', path, { ...HOST, 'content-type': 'application/x-www-form-urlencoded' }, undefined, new URLSearchParams(form).toString())
}
const mcp = (token: string, method: string, params?: unknown) => h.rpc({ ...HOST, ...bearer(token) }, method, params)

async function login(email: string, password: string): Promise<string> {
  const res = await h.run('POST', '/api/auth/login', {}, { email, password })
  expect(res.statusCode, res.body).toBe(200)
  return json(res).accessToken
}

async function register(redirectUris = [CALLBACK], name = 'Claude'): Promise<string> {
  const res = await postJson('/api/oauth/register', { client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: 'none' })
  expect(res.statusCode, res.body).toBe(201)
  return json(res).client_id
}

interface Flow {
  clientId: string
  verifier: string
  params: Record<string, string>
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: RESOURCE,
    scope: 'family:read calendar:read calendar:write lists:read',
    ...extra,
  }
}

async function startFlow(extra: Record<string, string> = {}): Promise<Flow> {
  const clientId = extra.client_id ?? (await register())
  const { verifier, challenge } = pkce()
  return { clientId, verifier, params: authorizeParams(clientId, challenge, extra) }
}

async function approve(flow: Flow, scopes: string[], token = session, householdId = h.householdId): Promise<RunResult> {
  return postJson('/api/oauth/authorize', { ...flow.params, householdId, scopes, decision: 'approve' }, bearer(token))
}

async function codeFrom(res: RunResult): Promise<string> {
  expect(res.statusCode, res.body).toBe(200)
  const u = new URL(json(res).redirect)
  expect(u.searchParams.get('state')).toBe('st-123')
  expect(u.searchParams.get('iss')).toBe(ORIGIN)
  return u.searchParams.get('code')!
}

function exchange(flow: Flow, code: string, extra: Record<string, string> = {}) {
  return postForm('/api/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource: RESOURCE,
    ...extra,
  })
}

function refresh(clientId: string, refreshToken: string) {
  return postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: RESOURCE })
}

// register → consent → code → tokens, with the given scopes granted.
async function connect(scopes: string[]) {
  const flow = await startFlow()
  const code = await codeFrom(await approve(flow, scopes))
  const res = await exchange(flow, code)
  expect(res.statusCode, res.body).toBe(200)
  const body = json(res)
  return { flow, access: body.access_token as string, refresh: body.refresh_token as string, body, res }
}

async function grantIdOf(access: string): Promise<string> {
  return JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).grant_id
}

beforeAll(async () => {
  // This suite registers far more clients than one address ever would.
  process.env.RATE_LIMIT_OAUTH_REGISTER_MAX = '10000'
  h = await startMcpHarness()
  session = await login('kevin@example.com', 'ownerpass1')
  const teen = await h.addMember('Tess', 'teen')
  teenId = teen.id
  const setLogin = await h.call('PUT', `/api/persons/${teenId}/login`, h.owner, { email: 'tess@example.com', password: 'teenpass12' })
  expect(setLogin.statusCode, setLogin.body).toBe(200)
  teenSession = await login('tess@example.com', 'teenpass12')
})

afterAll(async () => {
  await h?.close()
})

describe('discovery', () => {
  it('serves protected-resource metadata at the path-inserted and the root location', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await get(path)
      expect(res.statusCode, path).toBe(200)
      const doc = json(res)
      expect(doc.resource).toBe(RESOURCE)
      expect(doc.authorization_servers).toEqual([ORIGIN])
      expect(doc.bearer_methods_supported).toEqual(['header'])
      expect(doc.scopes_supported).toContain('calendar:write')
    }
  })

  it('offers only the scopes some MCP tool uses', async () => {
    const doc = json(await get('/.well-known/oauth-protected-resource/mcp'))
    const { toolRegistry } = await import('../src/modules/mcp/registry')
    const used = [...new Set(toolRegistry().map((t) => t.scope))].sort()
    expect(doc.scopes_supported).toEqual(used)
    // pantry has no tool, so a connector is never offered it.
    expect(doc.scopes_supported).not.toContain('pantry:read')
  })

  it('serves authorization-server metadata (RFC 8414) with S256 and public clients', async () => {
    const res = await get('/.well-known/oauth-authorization-server')
    expect(res.statusCode).toBe(200)
    const doc = json(res)
    expect(doc).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    })
    expect(doc.scopes_supported).toEqual(json(await get('/.well-known/oauth-protected-resource')).scopes_supported)
  })

  it('builds every URL from PUBLIC_BASE_URL when it is set', async () => {
    process.env.PUBLIC_BASE_URL = 'https://Family.Example.com/'
    try {
      const doc = json(await get('/.well-known/oauth-protected-resource/mcp'))
      expect(doc.resource).toBe('https://family.example.com/mcp')
      expect(doc.authorization_servers).toEqual(['https://family.example.com'])
    } finally {
      delete process.env.PUBLIC_BASE_URL
    }
  })

  it('401s /mcp without credentials and points at the metadata', async () => {
    const res = await h.rpc(HOST, 'ping')
    expect(res.statusCode).toBe(401)
    expect(json(res).error).toBe('AuthError')
    const www = header(res, 'www-authenticate')!
    expect(www).toMatch(/^Bearer /)
    expect(www).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
    expect(www).toMatch(/scope="[^"]*calendar:read[^"]*"/)
    expect(www).not.toContain('error=')
  })

  it('names invalid_token when a presented token is bad', async () => {
    const res = await mcp('not-a-jwt', 'ping')
    expect(res.statusCode).toBe(401)
    expect(header(res, 'www-authenticate')).toContain('error="invalid_token"')
  })
})

describe('dynamic client registration', () => {
  it('registers a public client and echoes its metadata', async () => {
    const res = await postJson('/api/oauth/register', { client_name: 'Claude', redirect_uris: [CALLBACK] })
    expect(res.statusCode, res.body).toBe(201)
    const body = json(res)
    expect(body.client_id).toEqual(expect.any(String))
    expect(body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
    expect(body.client_secret).toBeUndefined()
  })

  it('accepts loopback http redirects and refuses any other http one', async () => {
    expect((await postJson('/api/oauth/register', { client_name: 'CLI', redirect_uris: ['http://127.0.0.1:33418/cb', 'http://localhost/callback'] })).statusCode).toBe(201)
    const bad = await postJson('/api/oauth/register', { client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] })
    expect(bad.statusCode).toBe(400)
    expect(json(bad).error).toBe('invalid_redirect_uri')
  })

  it('refuses a missing redirect list, a fragment, and a confidential client', async () => {
    const none = await postJson('/api/oauth/register', { client_name: 'X' })
    expect(json(none).error).toBe('invalid_redirect_uri')
    const frag = await postJson('/api/oauth/register', { client_name: 'X', redirect_uris: ['https://a.example/cb#x'] })
    expect(json(frag).error).toBe('invalid_redirect_uri')
    const secret = await postJson('/api/oauth/register', { client_name: 'X', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' })
    expect(secret.statusCode).toBe(400)
    expect(json(secret).error).toBe('invalid_client_metadata')
  })

  it('prunes registrations nobody ever authorized with', async () => {
    await h.sql(`insert into oauth_clients (client_id, client_name, redirect_uris, created_at) values ('stale-client', 'Old', $1, now() - interval '30 days')`, [[CALLBACK]])
    await h.sql(`insert into oauth_clients (client_id, client_name, redirect_uris, created_at, last_used_at) values ('used-client', 'Old', $1, now() - interval '30 days', now())`, [[CALLBACK]])
    await register()
    const rows = await h.sql<{ client_id: string }>(`select client_id from oauth_clients where client_id in ('stale-client', 'used-client')`)
    expect(rows.map((r) => r.client_id)).toEqual(['used-client'])
  })
})

describe('client ID metadata documents', () => {
  const CIMD = 'https://claude.ai/oauth/claude-code-client-metadata'
  let fetched: string[] = []

  beforeAll(async () => {
    const { setClientMetadataFetcherForTest } = await import('../src/modules/oauth/clients')
    setClientMetadataFetcherForTest(async (url) => {
      fetched.push(url)
      if (url === CIMD) {
        return { status: 200, cacheControl: 'max-age=600', body: JSON.stringify({ client_id: CIMD, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }) }
      }
      if (url === 'https://liar.example/meta') {
        return { status: 200, body: JSON.stringify({ client_id: 'https://someone-else.example/meta', client_name: 'Liar', redirect_uris: [CALLBACK] }) }
      }
      return { status: 404, body: '' }
    })
  })
  afterEach(() => {
    fetched = []
  })
  afterAll(async () => {
    const { setClientMetadataFetcherForTest } = await import('../src/modules/oauth/clients')
    setClientMetadataFetcherForTest(null)
  })

  const info = (params: Record<string, string>) => get('/api/oauth/authorize/info', bearer(session), params)

  it('fetches the document and lets a loopback redirect vary only its port', async () => {
    const { challenge } = pkce()
    const ok = await info(authorizeParams(CIMD, challenge, { redirect_uri: 'http://localhost:53682/callback' }))
    expect(ok.statusCode, ok.body).toBe(200)
    expect(json(ok).client).toMatchObject({ name: 'Claude Code', redirectHost: 'localhost:53682' })

    const otherPath = await info(authorizeParams(CIMD, challenge, { redirect_uri: 'http://localhost:53682/elsewhere' }))
    expect(otherPath.statusCode).toBe(400)
    expect(json(otherPath).error).toBe('invalid_request')
    expect(json(otherPath).redirect).toBeUndefined()
  })

  it('caches the document per its Cache-Control', async () => {
    const { challenge } = pkce()
    await info(authorizeParams(CIMD, challenge, { redirect_uri: 'http://127.0.0.1:5000/callback' }))
    await info(authorizeParams(CIMD, challenge, { redirect_uri: 'http://127.0.0.1:5001/callback' }))
    expect(fetched).toEqual([])
  })

  it('refuses a document whose client_id is not its own URL, or that will not load', async () => {
    const { challenge } = pkce()
    const liar = await info(authorizeParams('https://liar.example/meta', challenge))
    expect(liar.statusCode).toBe(400)
    expect(json(liar).error).toBe('invalid_client')
    expect(json(liar).redirect).toBeUndefined()
    const gone = await info(authorizeParams('https://gone.example/meta', challenge))
    expect(json(gone).error).toBe('invalid_client')
  })
})

describe('authorize', () => {
  const info = (params: Record<string, string>, token = session) => get('/api/oauth/authorize/info', bearer(token), params)

  it('needs a signed-in session', async () => {
    const flow = await startFlow()
    expect((await get('/api/oauth/authorize/info', {}, flow.params)).statusCode).toBe(401)
    expect((await postJson('/api/oauth/authorize', { ...flow.params, decision: 'approve' })).statusCode).toBe(401)
  })

  it('describes the client, the redirect host, the scopes and the households', async () => {
    const flow = await startFlow()
    const res = await info(flow.params)
    expect(res.statusCode, res.body).toBe(200)
    const body = json(res)
    expect(body.client).toEqual({ id: flow.clientId, name: 'Claude', redirectHost: 'claude.ai' })
    expect(body.scopes.map((s: { scope: string }) => s.scope)).toEqual(['family:read', 'calendar:read', 'calendar:write', 'lists:read'])
    for (const s of body.scopes) expect(s.description).toEqual(expect.any(String))
    expect(body.scopes.find((s: { scope: string }) => s.scope === 'calendar:write').write).toBe(true)
    expect(body.households).toEqual([{ id: h.householdId, name: 'Sites', canConnect: true }])
  })

  it('offers every tool scope when the client asks for none, and ignores offline_access', async () => {
    const all = json(await get('/.well-known/oauth-protected-resource')).scopes_supported
    const flow = await startFlow({ scope: '' })
    expect(json(await info(flow.params)).scopes.map((s: { scope: string }) => s.scope).sort()).toEqual([...all].sort())
    const offline = await startFlow({ scope: 'calendar:read offline_access' })
    expect(json(await info(offline.params)).scopes.map((s: { scope: string }) => s.scope)).toEqual(['calendar:read'])
  })

  it('never redirects for an unknown client or an unregistered redirect_uri', async () => {
    const { challenge } = pkce()
    const unknown = await info(authorizeParams('no-such-client', challenge))
    expect(unknown.statusCode).toBe(400)
    expect(json(unknown)).toMatchObject({ error: 'invalid_client' })
    expect(json(unknown).redirect).toBeUndefined()

    const flow = await startFlow({ redirect_uri: 'https://evil.example/cb' })
    const wrong = await info(flow.params)
    expect(wrong.statusCode).toBe(400)
    expect(json(wrong).redirect).toBeUndefined()
  })

  it('sends redirectable errors back to the client with its state', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge: '' }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ scope: 'pantry:read' }, 'invalid_scope'],
      [{ scope: 'nonsense' }, 'invalid_scope'],
    ]
    for (const [extra, error] of cases) {
      const flow = await startFlow(extra)
      const res = await info(flow.params)
      expect(res.statusCode, JSON.stringify(extra)).toBe(400)
      const redirect = new URL(json(res).redirect)
      expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK)
      expect(redirect.searchParams.get('error')).toBe(error)
      expect(redirect.searchParams.get('state')).toBe('st-123')
    }
  })

  // Clients form-encode the query, so a space in `scope` arrives as `+`. The harness hands
  // the app a ready-made object; only the real Node server decodes a raw query string.
  it('reads a +-encoded scope through the real HTTP server', async () => {
    const { createHttpServer } = await import('../src/platform/http-server')
    const app = (await import('../src/app')).default
    const server = createHttpServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as import('node:net').AddressInfo
      const flow = await startFlow()
      const qs = new URLSearchParams({ ...flow.params, scope: 'family:read calendar:read', state: 'a b%c' }).toString()
      expect(qs).toContain('scope=family%3Aread+calendar%3Aread')
      const res = await fetch(`http://127.0.0.1:${port}/api/oauth/authorize/info?${qs}`, {
        headers: { ...HOST, authorization: `Bearer ${session}` },
      })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(((await res.json()) as { scopes: Array<{ scope: string }> }).scopes.map((s) => s.scope)).toEqual(['family:read', 'calendar:read'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('accepts the resource in any canonical spelling', async () => {
    const flow = await startFlow({ resource: 'https://WAFFLED.example/mcp/' })
    expect((await info(flow.params)).statusCode).toBe(200)
  })

  it('a cancel returns access_denied to the client', async () => {
    const flow = await startFlow()
    const res = await postJson('/api/oauth/authorize', { ...flow.params, decision: 'deny' }, bearer(session))
    expect(res.statusCode).toBe(200)
    const u = new URL(json(res).redirect)
    expect(u.searchParams.get('error')).toBe('access_denied')
    expect(u.searchParams.get('state')).toBe('st-123')
  })

  it('approves only scopes the client asked for', async () => {
    const flow = await startFlow()
    const res = await approve(flow, ['chores:write'])
    expect(res.statusCode).toBe(400)
    const empty = await approve(flow, [])
    expect(empty.statusCode).toBe(400)
  })

  it('refuses a person without ai.connect, at info and at approve', async () => {
    const flow = await startFlow()
    const body = json(await info(flow.params, teenSession))
    expect(body.households).toEqual([{ id: h.householdId, name: 'Sites', canConnect: false }])
    const res = await approve(flow, ['calendar:read'], teenSession)
    expect(res.statusCode).toBe(403)
    expect(await h.sql(`select 1 from oauth_grants where person_id = $1`, [teenId])).toEqual([])
  })

  it('refuses a household the account is not a member of', async () => {
    const [other] = await h.sql<{ id: string }>(`insert into households (name, timezone) values ('Other', 'UTC') returning id`)
    const flow = await startFlow()
    expect((await approve(flow, ['calendar:read'], session, other.id)).statusCode).toBe(403)
  })

  it('stores the code hashed and single-use', async () => {
    const flow = await startFlow()
    const code = await codeFrom(await approve(flow, ['calendar:read']))
    expect(await h.sql(`select 1 from oauth_codes where code_hash = $1`, [code])).toEqual([])
    const [row] = await h.sql<{ ttl: number }>(
      `select extract(epoch from expires_at - created_at)::int as ttl from oauth_codes where code_hash = $1`,
      [createHash('sha256').update(code).digest('hex')]
    )
    expect(row.ttl).toBe(60)
  })
})

describe('token endpoint', () => {
  it('exchanges a code for an MCP access token and a refresh token', async () => {
    const { body, res, access } = await connect(['family:read', 'calendar:read'])
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'family:read calendar:read' })
    expect(body.expires_in).toBeGreaterThan(0)
    expect(body.refresh_token).toEqual(expect.any(String))
    expect(header(res, 'cache-control')).toBe('no-store')
    const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString())
    expect(claims.aud).toBe(RESOURCE)
    expect(claims.scope).toBe('family:read calendar:read')
    expect(claims.grant_id).toEqual(expect.any(String))
    expect(claims.client_id).toEqual(expect.any(String))
  })

  it('refuses a wrong verifier, redirect_uri, client or resource', async () => {
    const cases: Array<Record<string, string>> = [
      { code_verifier: b64url(randomBytes(32)) },
      { redirect_uri: 'https://claude.ai/other' },
      { client_id: 'someone-else' },
      { resource: 'https://other.example/mcp' },
    ]
    for (const extra of cases) {
      const flow = await startFlow()
      const code = await codeFrom(await approve(flow, ['calendar:read']))
      const res = await exchange(flow, code, extra)
      expect(res.statusCode, JSON.stringify(extra)).toBe(400)
      expect(['invalid_grant', 'invalid_target']).toContain(json(res).error)
    }
  })

  it('a replayed code is invalid_grant and kills the grant it issued', async () => {
    const flow = await startFlow()
    const code = await codeFrom(await approve(flow, ['calendar:read']))
    const first = await exchange(flow, code)
    expect(first.statusCode).toBe(200)
    const replay = await exchange(flow, code)
    expect(replay.statusCode).toBe(400)
    expect(json(replay).error).toBe('invalid_grant')
    expect((await mcp(json(first).access_token, 'ping')).statusCode).toBe(401)
  })

  it('a failed exchange does not spend the code or revoke its grant', async () => {
    const flow = await startFlow()
    const code = await codeFrom(await approve(flow, ['calendar:read']))
    const bad: Array<Record<string, string>> = [{ code_verifier: b64url(randomBytes(32)) }, { client_id: 'someone-else' }, { resource: 'https://other.example/mcp' }]
    for (const extra of bad) {
      expect((await exchange(flow, code, extra)).statusCode, JSON.stringify(extra)).toBe(400)
    }
    const ok = await exchange(flow, code)
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await mcp(json(ok).access_token, 'ping')).statusCode).toBe(200)
  })

  it('a replay without the verifier is refused but does not revoke', async () => {
    const flow = await startFlow()
    const code = await codeFrom(await approve(flow, ['calendar:read']))
    const first = await exchange(flow, code)
    expect(first.statusCode).toBe(200)
    expect(json(await exchange(flow, code, { code_verifier: b64url(randomBytes(32)) })).error).toBe('invalid_grant')
    expect((await mcp(json(first).access_token, 'ping')).statusCode).toBe(200)
  })

  it('an expired code is invalid_grant', async () => {
    const flow = await startFlow()
    const code = await codeFrom(await approve(flow, ['calendar:read']))
    await h.sql(`update oauth_codes set expires_at = now() - interval '1 second'`)
    expect(json(await exchange(flow, code)).error).toBe('invalid_grant')
  })

  it('reads form-encoded bodies only for its grant types', async () => {
    const res = await postForm('/api/oauth/token', { grant_type: 'client_credentials' })
    expect(res.statusCode).toBe(400)
    expect(json(res).error).toBe('unsupported_grant_type')
  })

  it('rotates the refresh token on every use; a replay revokes the whole grant', async () => {
    const { flow, refresh: r1 } = await connect(['calendar:read'])
    const second = await refresh(flow.clientId, r1)
    expect(second.statusCode, second.body).toBe(200)
    const r2 = json(second).refresh_token
    expect(r2).not.toBe(r1)
    expect(json(second).scope).toBe('calendar:read')
    const access2 = json(second).access_token
    expect((await mcp(access2, 'ping')).statusCode).toBe(200)

    const replay = await refresh(flow.clientId, r1)
    expect(replay.statusCode).toBe(400)
    expect(json(replay).error).toBe('invalid_grant')
    // The replay revoked the grant, so the newest pair is dead too.
    expect(json(await refresh(flow.clientId, r2)).error).toBe('invalid_grant')
    expect((await mcp(access2, 'ping')).statusCode).toBe(401)
  })

  it('a refresh by another client is invalid_grant', async () => {
    const { refresh: r1 } = await connect(['calendar:read'])
    expect(json(await refresh('someone-else', r1)).error).toBe('invalid_grant')
  })

  it('a refused refresh does not spend the refresh token', async () => {
    const { flow, refresh: r1 } = await connect(['calendar:read'])
    expect(json(await refresh('someone-else', r1)).error).toBe('invalid_grant')
    const widened = await postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: r1, client_id: flow.clientId, scope: 'calendar:read calendar:write' })
    expect(json(widened).error).toBe('invalid_scope')
    const wrongResource = await postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: r1, client_id: flow.clientId, resource: 'https://other.example/mcp' })
    expect(json(wrongResource).error).toBe('invalid_target')
    const ok = await refresh(flow.clientId, r1)
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('refuses a refresh once the person loses ai.connect', async () => {
    const member = await h.addMember('Ada', 'adult')
    const setLogin = await h.call('PUT', `/api/persons/${member.id}/login`, h.owner, { email: 'ada@example.com', password: 'adapass123' })
    expect(setLogin.statusCode).toBe(200)
    const ada = await login('ada@example.com', 'adapass123')
    const flow = await startFlow()
    const code = await codeFrom(await approve(flow, ['calendar:read'], ada))
    const tokens = json(await exchange(flow, code))
    expect((await mcp(tokens.access_token, 'ping')).statusCode).toBe(200)

    const off = await h.call('PUT', '/api/permissions', h.owner, { permissions: { adult: { 'ai.connect': false } } })
    expect(off.statusCode).toBe(200)
    try {
      // Takes effect on the next call, not the next login.
      expect((await mcp(tokens.access_token, 'ping')).statusCode).toBe(401)
      expect(json(await refresh(flow.clientId, tokens.refresh_token)).error).toBe('invalid_grant')
    } finally {
      await h.call('PUT', '/api/permissions', h.owner, { permissions: { adult: { 'ai.connect': true } } })
    }
  })
})

describe('tokens are confined to /mcp', () => {
  it('an MCP access token is 401 on a REST route', async () => {
    const { access } = await connect(['family:read'])
    expect((await h.run('GET', '/api/household', { ...HOST, ...bearer(access) })).statusCode).toBe(401)
    expect((await h.run('GET', '/api/events', { ...HOST, ...bearer(access) })).statusCode).toBe(401)
  })

  it('a connector refresh token cannot become a user session', async () => {
    const { refresh: r } = await connect(['family:read'])
    const res = await h.run('POST', '/api/auth/refresh', {}, { refreshToken: r })
    expect(res.statusCode).toBe(401)
  })

  it('an MCP access token minted for another host is refused', async () => {
    const { access } = await connect(['family:read'])
    const res = await h.rpc({ 'x-forwarded-host': 'other.example', 'x-forwarded-proto': 'https', ...bearer(access) }, 'ping')
    expect(res.statusCode).toBe(401)
  })

  it('a user session still has full rights on /mcp', async () => {
    const res = await mcp(session, 'tools/list')
    expect(res.statusCode).toBe(200)
    expect(json(res).result.tools.map((t: { name: string }) => t.name)).toContain('add_event')
  })
})

describe('/mcp with a grant token', () => {
  it('sees and calls only the tools its scopes cover', async () => {
    const { access } = await connect(['family:read', 'calendar:read'])
    const names = json(await mcp(access, 'tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('whoami')
    expect(names).toContain('list_events')
    expect(names).not.toContain('add_event')
    expect(names).not.toContain('list_chores')

    const who = await h.tool({ ...HOST, ...bearer(access) }, 'whoami')
    expect(who.isError).toBeFalsy()
    expect(who.structuredContent.person.id).toBe(h.ownerId)

    const refused = await h.tool({ ...HOST, ...bearer(access) }, 'add_event', { title: 'Nope', startsAt: '2026-12-01T10:00' })
    expect(refused.isError).toBe(true)
  })

  it('audits a write with the grant that made it', async () => {
    const { access } = await connect(['calendar:write'])
    const grantId = await grantIdOf(access)
    const out = await h.tool({ ...HOST, ...bearer(access) }, 'add_event', { title: 'Dentist', startsAt: '2026-12-02T10:00' })
    expect(out.isError, JSON.stringify(out)).toBeFalsy()
    const rows = await h.sql<{ grant_id: string; api_key_id: string | null; outcome: string }>(
      `select grant_id, api_key_id, outcome from mcp_audit where tool = 'add_event' and grant_id = $1`,
      [grantId]
    )
    expect(rows).toEqual([{ grant_id: grantId, api_key_id: null, outcome: 'ok' }])
  })
})

describe('connected apps', () => {
  it('lists the account’s grants and revokes one', async () => {
    const { flow, access, refresh: r } = await connect(['family:read', 'calendar:read'])
    const grantId = await grantIdOf(access)
    await mcp(access, 'ping')

    const list = await h.run('GET', '/api/oauth/grants', bearer(session))
    expect(list.statusCode).toBe(200)
    const grant = json(list).grants.find((g: { id: string }) => g.id === grantId)
    expect(grant).toMatchObject({
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      scopes: ['family:read', 'calendar:read'],
      householdId: h.householdId,
      householdName: 'Sites',
    })
    expect(json(list).scopeDescriptions['calendar:read']).toBe('See the family calendar')
    expect(grant.createdAt).toEqual(expect.any(String))
    expect(grant.lastUsedAt).toEqual(expect.any(String))

    // Another member cannot see or revoke it.
    expect(json(await h.run('GET', '/api/oauth/grants', bearer(teenSession))).grants).toEqual([])
    expect((await h.run('DELETE', `/api/oauth/grants/${grantId}`, bearer(teenSession))).statusCode).toBe(404)

    const del = await h.run('DELETE', `/api/oauth/grants/${grantId}`, bearer(session))
    expect(del.statusCode).toBe(204)
    expect((await mcp(access, 'ping')).statusCode).toBe(401)
    expect(json(await refresh(flow.clientId, r)).error).toBe('invalid_grant')
    expect(await h.sql(`select 1 from oauth_refresh_tokens where grant_id = $1`, [grantId])).toEqual([])
    expect(json(await h.run('GET', '/api/oauth/grants', bearer(session))).grants.map((g: { id: string }) => g.id)).not.toContain(grantId)
  })

  it('an MCP token cannot manage grants', async () => {
    const { access } = await connect(['family:read'])
    expect((await h.run('GET', '/api/oauth/grants', { ...HOST, ...bearer(access) })).statusCode).toBe(401)
  })
})

describe('full happy path', () => {
  it('register → authorize → token → tools/list → refresh → revoke → 401', async () => {
    const clientId = await register()
    const { verifier, challenge } = pkce()
    const params = authorizeParams(clientId, challenge, { scope: 'family:read lists:read' })
    const info = await get('/api/oauth/authorize/info', bearer(session), params)
    expect(info.statusCode).toBe(200)
    const ok = await postJson('/api/oauth/authorize', { ...params, householdId: h.householdId, scopes: ['family:read', 'lists:read'], decision: 'approve' }, bearer(session))
    const code = new URL(json(ok).redirect).searchParams.get('code')!
    const tokens = json(await postForm('/api/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: RESOURCE }))
    const listed = json(await mcp(tokens.access_token, 'tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(listed).toContain('get_grocery_list')
    const rotated = json(await refresh(clientId, tokens.refresh_token))
    expect(rotated.access_token).toEqual(expect.any(String))
    const grantId = await grantIdOf(rotated.access_token)
    expect(grantId).toBe(await grantIdOf(tokens.access_token))
    expect((await h.run('DELETE', `/api/oauth/grants/${grantId}`, bearer(session))).statusCode).toBe(204)
    const after = await mcp(rotated.access_token, 'tools/list')
    expect(after.statusCode).toBe(401)
    expect(header(after, 'www-authenticate')).toContain('resource_metadata=')
  })
})
