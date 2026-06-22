// OIDC (backend-mediated, Immich-style). Config lives in the DB (auth_config,
// edited by an admin in Settings — see the admin routes below). We run the
// authorization-code + PKCE flow server-side, verify the IdP's ID token, then mint
// our OWN session via the same mintAccess/issueRefresh password login uses — so
// every downstream consumer (requireAuth, the PowerSync token exchange) is
// unchanged. Provisioning is invite-gated: the verified email must already belong
// to a person on file. Mirrors the Google-calendar OAuth pattern (one-time state
// row → public callback → code exchange); tokens never ride the redirect URL —
// the callback stashes a one-time handoff code the SPA exchanges for tokens.
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import jwt, { type JwtPayload, type GetPublicKeyOrSecret } from 'jsonwebtoken'
import { JwksClient } from 'jwks-rsa'
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { encryptSecret, decryptSecret, encryptionAvailable } from '../../platform/crypto'
import { mintAccess, issueRefresh } from './auth'
import { requireTenant, requireAdmin, findTenantBySub, findPersonByEmail, linkIdentity } from '../households/households'

type Api = ReturnType<typeof createAPI>

const STATE_TTL_MIN = 10
const HANDOFF_TTL_MIN = 5
const base64url = (b: Buffer) => b.toString('base64url')
const sha256b64url = (s: string) => base64url(createHash('sha256').update(s).digest())

// ── config ───────────────────────────────────────────────────────────────────
export interface AuthConfig {
  oidcEnabled: boolean
  issuerUrl: string | null
  clientId: string | null
  clientSecretEnc: string | null
  scopes: string
  buttonLabel: string
  passwordLoginEnabled: boolean
}

export async function getAuthConfig(): Promise<AuthConfig> {
  const { rows } = await query<{
    oidc_enabled: boolean
    issuer_url: string | null
    client_id: string | null
    client_secret_enc: string | null
    scopes: string
    button_label: string
    password_login_enabled: boolean
  }>(`select oidc_enabled, issuer_url, client_id, client_secret_enc, scopes, button_label, password_login_enabled from auth_config where id = true`)
  const r = rows[0]
  // Defaults match the migration, so a missing row (shouldn't happen) is safe.
  return {
    oidcEnabled: r?.oidc_enabled ?? false,
    issuerUrl: r?.issuer_url ?? null,
    clientId: r?.client_id ?? null,
    clientSecretEnc: r?.client_secret_enc ?? null,
    scopes: r?.scopes ?? 'openid email profile',
    buttonLabel: r?.button_label ?? 'Sign in with SSO',
    passwordLoginEnabled: r?.password_login_enabled ?? true,
  }
}

// OIDC is usable only when enabled, fully configured, and we can decrypt the secret.
export function oidcReady(cfg: AuthConfig): boolean {
  return cfg.oidcEnabled && !!cfg.issuerUrl && !!cfg.clientId && !!cfg.clientSecretEnc && encryptionAvailable()
}

// Which login methods the client should render. Lockout-guarded: if password login
// is off but OIDC isn't usable, fall back to showing passwords anyway. The
// AUTH_FORCE_PASSWORD break-glass always shows them (operator recovery).
export async function loginMethods(): Promise<{ methods: string[]; oidc?: { buttonLabel: string } }> {
  const cfg = await getAuthConfig()
  const ready = oidcReady(cfg)
  const forcePw = process.env.AUTH_FORCE_PASSWORD === '1'
  const methods: string[] = []
  if (cfg.passwordLoginEnabled || forcePw || !ready) methods.push('password')
  if (ready) methods.push('oidc')
  return { methods, oidc: ready ? { buttonLabel: cfg.buttonLabel } : undefined }
}

// ── discovery + ID-token verification ─────────────────────────────────────────
interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}
const discoveryCache = new Map<string, { doc: Discovery; at: number }>()
const jwksClients = new Map<string, JwksClient>()

export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer)
  // 1h cache; we can't use Date.now()-free here so use a coarse process clock.
  if (cached && Date.now() - cached.at < 3_600_000) return cached.doc
  const url = issuer.replace(/\/$/, '') + '/.well-known/openid-configuration'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${url}`)
  const doc = (await res.json()) as Discovery
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document is missing required endpoints')
  }
  discoveryCache.set(issuer, { doc, at: Date.now() })
  return doc
}

function keyResolver(jwksUri: string): GetPublicKeyOrSecret {
  let client = jwksClients.get(jwksUri)
  if (!client) {
    client = new JwksClient({ jwksUri, cache: true, rateLimit: true })
    jwksClients.set(jwksUri, client)
  }
  const c = client
  return (header, callback) => {
    c.getSigningKey(header.kid, (err, key) => {
      if (err || !key) return callback(err ?? new Error('No signing key'))
      callback(null, key.getPublicKey())
    })
  }
}

function verifyIdToken(idToken: string, disco: Discovery, clientId: string, nonce: string): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      keyResolver(disco.jwks_uri),
      { algorithms: ['RS256'], issuer: disco.issuer, audience: clientId },
      (err, decoded) => {
        if (err) return reject(err)
        const claims = decoded as JwtPayload
        if (claims.nonce !== nonce) return reject(new Error('OIDC nonce mismatch'))
        resolve(claims)
      }
    )
  })
}

// Namespaced subject for the identities table so an OIDC sub can't collide with a
// password credential id or another IdP's sub.
function oidcSubject(issuer: string, sub: string): string {
  return `oidc:${createHash('sha256').update(issuer).digest('hex').slice(0, 12)}:${sub}`
}

// ── flow helpers ───────────────────────────────────────────────────────────────
// Absolute base URL for building the redirect_uri the IdP calls back. Honors
// PUBLIC_BASE_URL (set it when behind a proxy that rewrites host), else derives
// from the forwarded request headers (Caddy sets x-forwarded-proto/host).
function baseUrl(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '')
  if (env) return env
  const h = req.headers as Record<string, string | undefined>
  const proto = h['x-forwarded-proto'] ?? 'http'
  const host = h['x-forwarded-host'] ?? h.host ?? 'localhost:8080'
  return `${proto}://${host}`
}
function callbackUri(req: Request): string {
  return `${baseUrl(req)}/api/auth/oidc/callback`
}

export function registerOidcRoutes(api: Api): void {
  // PUBLIC — kick off login: store state+PKCE+nonce, redirect to the IdP.
  api.get('/api/auth/oidc/start', async (req: Request, res: Response) => {
    const cfg = await getAuthConfig()
    if (!oidcReady(cfg)) return res.status(404).json({ error: 'NotConfigured', message: 'OIDC is not enabled.' })
    let disco: Discovery
    try {
      disco = await discover(cfg.issuerUrl!)
    } catch (err) {
      console.error('oidc start: discovery failed', err)
      return res.status(502).json({ error: 'BadGateway', message: 'Could not reach the identity provider.' })
    }
    const state = base64url(randomBytes(24))
    const nonce = base64url(randomBytes(16))
    const verifier = base64url(randomBytes(32))
    const redirectTo = typeof req.query.redirect === 'string' ? req.query.redirect : null
    await query(
      `insert into oidc_login_states (state, code_verifier, nonce, redirect_to) values ($1, $2, $3, $4)`,
      [state, verifier, nonce, redirectTo]
    )
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId!,
      redirect_uri: callbackUri(req),
      scope: cfg.scopes,
      state,
      nonce,
      code_challenge: sha256b64url(verifier),
      code_challenge_method: 'S256',
      // Always show the IdP's account chooser. Without this, an IdP with a live
      // session (the cookie outlives our sign-out) silently re-authenticates the
      // same account, so a signed-out user can never pick a different one.
      prompt: 'select_account',
    })
    res.redirect(`${disco.authorization_endpoint}?${params.toString()}`)
  })

  // PUBLIC — the IdP redirects the browser here. Consume the state, exchange the
  // code, verify the ID token, resolve invite-gated, mint a session, then redirect
  // back to the SPA with a one-time handoff code.
  api.get('/api/auth/oidc/callback', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>
    if (q.error) return res.status(400).html(resultPage('Sign-in failed', q.error_description || q.error, appOrigin(req)))
    const code = q.code
    const state = q.state
    if (!code || !state) return res.status(400).html(resultPage('Sign-in failed', 'Missing authorization code or state.', appOrigin(req)))

    // One-time consume of the state (and sweep expired ones while here).
    const { rows } = await query<{ code_verifier: string; nonce: string; redirect_to: string | null }>(
      `delete from oidc_login_states
        where state = $1 and created_at > now() - interval '${STATE_TTL_MIN} minutes'
        returning code_verifier, nonce, redirect_to`,
      [state]
    )
    await query(`delete from oidc_login_states where created_at <= now() - interval '${STATE_TTL_MIN} minutes'`)
    const st = rows[0]
    if (!st) return res.status(400).html(resultPage('Sign-in expired', 'This sign-in link expired. Please try again.', appOrigin(req)))

    try {
      const cfg = await getAuthConfig()
      if (!oidcReady(cfg)) return failSignIn(req, res, st.redirect_to, 404, 'Sign-in failed', 'OIDC is not enabled.', 'oidc_disabled')
      const disco = await discover(cfg.issuerUrl!)
      const claims = await exchangeAndVerify(disco, cfg, code, st.code_verifier, st.nonce, callbackUri(req))

      const email = typeof claims.email === 'string' ? claims.email : null
      const emailVerified = claims.email_verified === true || claims.email_verified === 'true'
      const subject = oidcSubject(disco.issuer, String(claims.sub))

      // Returning SSO user → straight through.
      let tenant = await findTenantBySub(subject)
      if (!tenant) {
        // First SSO login: invite-gated. Require a verified email that's on file.
        if (!email || !emailVerified) {
          return failSignIn(req, res, st.redirect_to, 403, 'Sign-in blocked', 'Your identity provider did not supply a verified email.', 'no_verified_email')
        }
        const match = await findPersonByEmail(email)
        if (!match) {
          return failSignIn(req, res, st.redirect_to, 403, 'Not invited', `No Nook account uses ${email}. Ask an admin to add you first.`, 'not_invited')
        }
        await linkIdentity({ householdId: match.householdId, personId: match.personId, provider: 'oidc', subject, email, emailVerified })
        tenant = { sub: subject, personId: match.personId, householdId: match.householdId, isAdmin: false }
      }

      const handoff = randomUUID()
      await query(`insert into auth_handoffs (code, person_id, subject) values ($1, $2, $3)`, [handoff, tenant.personId, subject])
      const dest = appCallbackUrl(req, st.redirect_to, handoff)
      res.redirect(dest)
    } catch (err) {
      console.error('oidc callback failed', err)
      return failSignIn(req, res, st.redirect_to, 502, 'Sign-in failed', 'Could not complete sign-in. Please try again.', 'sign_in_failed')
    }
  })

  // PUBLIC — exchange the one-time handoff code for a real session.
  api.post('/api/auth/oidc/exchange', async (req: Request, res: Response) => {
    const code = ((req.body ?? {}) as { code?: string }).code
    if (!code) return res.status(400).json({ error: 'BadRequest', message: 'code is required' })
    const { rows } = await query<{ person_id: string; subject: string }>(
      `update auth_handoffs set consumed_at = now()
        where code = $1 and consumed_at is null and created_at > now() - interval '${HANDOFF_TTL_MIN} minutes'
        returning person_id, subject`,
      [code]
    )
    const h = rows[0]
    if (!h) return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired sign-in.' })
    const access = mintAccess(h.subject)
    const refreshToken = await issueRefresh(h.person_id, h.subject)
    return res.status(200).json({ accessToken: access.token, refreshToken, expiresIn: access.expiresIn })
  })

  // ── admin config (Settings → Login & security) ──────────────────────────────
  // Returns config WITHOUT the secret (only whether one is set).
  api.get('/api/auth/config', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const cfg = await getAuthConfig()
    return {
      oidcEnabled: cfg.oidcEnabled,
      issuerUrl: cfg.issuerUrl,
      clientId: cfg.clientId,
      secretSet: !!cfg.clientSecretEnc,
      scopes: cfg.scopes,
      buttonLabel: cfg.buttonLabel,
      passwordLoginEnabled: cfg.passwordLoginEnabled,
      encryptionAvailable: encryptionAvailable(),
    }
  })

  // Update config. Secret is encrypted at rest; omit it to keep the existing one,
  // pass "" to clear it. Guards against locking everyone out of password login.
  api.put('/api/auth/config', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const b = (req.body ?? {}) as {
      oidcEnabled?: boolean
      issuerUrl?: string | null
      clientId?: string | null
      clientSecret?: string | null
      scopes?: string
      buttonLabel?: string
      passwordLoginEnabled?: boolean
    }
    const cur = await getAuthConfig()
    const next: AuthConfig = {
      oidcEnabled: b.oidcEnabled ?? cur.oidcEnabled,
      issuerUrl: b.issuerUrl !== undefined ? b.issuerUrl?.trim() || null : cur.issuerUrl,
      clientId: b.clientId !== undefined ? b.clientId?.trim() || null : cur.clientId,
      clientSecretEnc:
        b.clientSecret === undefined
          ? cur.clientSecretEnc
          : b.clientSecret
            ? encryptSecret(b.clientSecret)
            : null,
      scopes: b.scopes?.trim() || cur.scopes,
      buttonLabel: b.buttonLabel?.trim() || cur.buttonLabel,
      passwordLoginEnabled: b.passwordLoginEnabled ?? cur.passwordLoginEnabled,
    }
    // Lockout guard: can only turn passwords off when OIDC is actually usable.
    if (!next.passwordLoginEnabled && !oidcReady(next)) {
      return res.status(400).json({ error: 'BadRequest', message: 'Enable and configure OIDC before disabling password login.' })
    }
    if (next.oidcEnabled && (!next.issuerUrl || !next.clientId || !next.clientSecretEnc)) {
      return res.status(400).json({ error: 'BadRequest', message: 'Issuer URL, client ID and client secret are all required to enable OIDC.' })
    }
    if (next.oidcEnabled && !encryptionAvailable()) {
      return res.status(400).json({ error: 'BadRequest', message: 'Set TOKEN_ENCRYPTION_KEY on the server to store the client secret securely.' })
    }
    await query(
      `update auth_config set oidc_enabled = $1, issuer_url = $2, client_id = $3, client_secret_enc = $4,
              scopes = $5, button_label = $6, password_login_enabled = $7, updated_at = now() where id = true`,
      [next.oidcEnabled, next.issuerUrl, next.clientId, next.clientSecretEnc, next.scopes, next.buttonLabel, next.passwordLoginEnabled]
    )
    return { ok: true }
  })

  // Probe the issuer's discovery document so the operator can validate before saving.
  api.post('/api/auth/config/test', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const issuer = ((req.body ?? {}) as { issuerUrl?: string }).issuerUrl?.trim()
    if (!issuer) return res.status(400).json({ error: 'BadRequest', message: 'issuerUrl is required' })
    try {
      const doc = await discover(issuer)
      return { ok: true, issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint }
    } catch (err) {
      // 200 with ok:false so the client renders the message instead of a throw.
      return { ok: false, message: (err as Error).message }
    }
  })
}

// Exchange the auth code at the token endpoint (PKCE), then verify the ID token.
async function exchangeAndVerify(
  disco: Discovery,
  cfg: AuthConfig,
  code: string,
  verifier: string,
  nonce: string,
  redirectUri: string
): Promise<JwtPayload> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId!,
    client_secret: decryptSecret(cfg.clientSecretEnc!),
    code_verifier: verifier,
  })
  const res = await fetch(disco.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text().catch(() => '')}`)
  const tokens = (await res.json()) as { id_token?: string }
  if (!tokens.id_token) throw new Error('token response had no id_token')
  return verifyIdToken(tokens.id_token, disco, cfg.clientId!, nonce)
}

// Where to send the browser after a successful callback: the SPA's /auth/callback,
// which exchanges the handoff code and lands the user in the app.
//
// Web passes an http(s) origin (e.g. https://host/) → we append /auth/callback.
// A native app passes a custom-scheme deep link (e.g. nook://auth/callback) whose
// `.origin` is the string "null", so we use the deep link itself as the base and
// just append the handoff code — that's the URL the app's ASWebAuthenticationSession
// is waiting to intercept.
function appCallbackUrl(req: Request, redirectTo: string | null, handoff: string): string {
  if (redirectTo) {
    try {
      const u = new URL(redirectTo)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        const sep = redirectTo.includes('?') ? '&' : '?'
        return `${redirectTo}${sep}code=${encodeURIComponent(handoff)}`
      }
      return `${u.origin}/auth/callback?code=${encodeURIComponent(handoff)}`
    } catch {
      /* fall through to the request-derived origin */
    }
  }
  return `${baseUrl(req)}/auth/callback?code=${encodeURIComponent(handoff)}`
}

// True for a native deep-link redirect (custom scheme like nook://), false for a
// web origin (http/https) or no redirect.
function isNativeRedirect(redirectTo: string | null): boolean {
  if (!redirectTo) return false
  try {
    const u = new URL(redirectTo)
    return u.protocol !== 'http:' && u.protocol !== 'https:'
  } catch {
    return false
  }
}

// End a failed sign-in. A native client gets the error bounced back through its
// deep link (so ASWebAuthenticationSession dismisses and the app renders a real,
// in-app message) — exactly mirroring the success path. A browser gets the
// self-contained result page with a working "Back to Nook" link.
function failSignIn(
  req: Request,
  res: Response,
  redirectTo: string | null,
  status: number,
  title: string,
  message: string,
  errorCode: string
): void {
  if (isNativeRedirect(redirectTo)) {
    const sep = redirectTo!.includes('?') ? '&' : '?'
    res.redirect(`${redirectTo}${sep}error=${encodeURIComponent(errorCode)}&error_description=${encodeURIComponent(message)}`)
    return
  }
  res.status(status).html(resultPage(title, message, appOrigin(req, redirectTo)))
}

// The SPA's origin: prefer the redirect the /start call carried (the real browser
// origin), else the derived base URL. Used so error pages link back to the app.
function appOrigin(req: Request, redirectTo?: string | null): string {
  if (redirectTo) {
    try {
      return new URL(redirectTo).origin
    } catch {
      /* fall through to derived base */
    }
  }
  return baseUrl(req)
}

// Minimal self-contained page for the OAuth dance ending without an SPA redirect
// (errors). Matches the Google-calendar callback's resultPage convention. backUrl
// is absolute so "Back to Nook" lands on the SPA, not wherever the api was reached.
function resultPage(title: string, message: string, backUrl = '/'): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f3ee;color:#2b2b2b">
<div style="max-width:380px;text-align:center;padding:28px">
<div style="font-size:22px;font-weight:700;margin-bottom:8px">${title}</div>
<div style="color:#6b6b6b;font-weight:500">${message}</div>
<a href="${backUrl}" style="display:inline-block;margin-top:18px;color:#e0653f;font-weight:700;text-decoration:none">← Back to Nook</a>
</div></body>`
}
