// PowerSync auth. Our api is the token authority: it serves a JWKS and mints
// short-lived RS256 tokens carrying the caller's real household_id (from the DB).
// PowerSync validates these against the JWKS; sync rules scope buckets by the
// household_id claim. This keeps PowerSync auth independent of Auth0.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto'
import jwt from 'jsonwebtoken'
import createAPI, { type Request, type Response } from 'lambda-api'
import { tenantRoute } from '../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

const ISSUER = 'waffled'
const AUDIENCE = 'powersync'
const KID = process.env.POWERSYNC_JWT_KID ?? 'waffled-powersync-1'
const TOKEN_TTL_SECONDS = 300 // 5 min; clients refresh via this endpoint

interface SigningKeys {
  privateKey: KeyObject
  publicJwk: JsonWebKey & { kid: string; alg: string; use: string }
}

let signingKeys: SigningKeys | null = null

// Use a provided PEM key in real deployments; fall back to an ephemeral keypair
// for local dev (the JWKS always matches the current signing key, tokens are short).
function keys(): SigningKeys {
  if (!signingKeys) {
    let privateKey: KeyObject
    let publicKey: KeyObject
    // Accept either a raw PEM (multi-line, e.g. via a mounted secret) or a single-line
    // base64 of that PEM — the latter survives .env / compose interpolation cleanly.
    const raw = process.env.POWERSYNC_JWT_PRIVATE_KEY
    const pem = raw?.includes('BEGIN') ? raw : raw ? Buffer.from(raw, 'base64').toString('utf8') : undefined
    if (pem) {
      privateKey = createPrivateKey(pem)
      publicKey = createPublicKey(privateKey)
    } else {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      privateKey = pair.privateKey
      publicKey = pair.publicKey
    }
    const jwk = publicKey.export({ format: 'jwk' })
    signingKeys = { privateKey, publicJwk: { ...jwk, kid: KID, alg: 'RS256', use: 'sig' } }
  }
  return signingKeys
}

export function getJwks(): { keys: JsonWebKey[] } {
  return { keys: [keys().publicJwk] }
}

export function mintPowerSyncToken(sub: string, householdId: string): string {
  return jwt.sign({ household_id: householdId }, keys().privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    subject: sub,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: TOKEN_TTL_SECONDS,
  })
}

// Where the client should open its sync stream. PowerSync is published on its own
// host port (not behind Caddy), so we can't just reuse the request origin — we keep
// the host the device actually reached us on and swap in PowerSync's port.
//
// A fixed default (it used to be compose's http://localhost:8090) is only ever
// correct on the server itself: every other device — kiosk tablet, phone — resolves
// localhost to ITSELF, never opens a sync stream, and silently degrades to REST-only
// with no realtime and no offline cache. Deriving per request fixes that for every
// device at once and survives the server's DHCP address changing.
//
// POWERSYNC_PUBLIC_URL still wins when set, for deployments that front PowerSync
// with its own hostname/TLS (where the derived host:port would be wrong).
const DEFAULT_POWERSYNC_PORT = '8090'

export function powerSyncPublicUrl(req: Request): string {
  const explicit = process.env.POWERSYNC_PUBLIC_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  // A proxy chain appends, so the client-facing value is the FIRST entry.
  const headers = req.headers as Record<string, string | undefined>
  const first = (value: string | undefined): string => (value ?? '').split(',')[0].trim()
  const proto = first(headers['x-forwarded-proto']) || 'http'
  const rawHost = first(headers['x-forwarded-host']) || first(headers.host) || 'localhost'
  // Drop the api's port, keeping IPv6 brackets intact, then apply PowerSync's.
  const hostname = rawHost.replace(/:\d+$/, '')
  const port = process.env.POWERSYNC_PORT?.trim() || DEFAULT_POWERSYNC_PORT
  return `${proto}://${hostname}:${port}`
}

export function registerPowerSyncRoutes(api: Api): void {
  // Public: PowerSync fetches this to validate client tokens.
  api.get('/api/auth/keys', async () => getJwks())

  // Authed: a provisioned member exchanges their session for a PowerSync token.
  api.get('/api/powersync/token', tenantRoute(async (tenant, req: Request, res: Response) => {
    const token = mintPowerSyncToken(tenant.sub, tenant.householdId)
    return res.status(200).json({
      token,
      powerSyncUrl: powerSyncPublicUrl(req),
      expiresIn: TOKEN_TTL_SECONDS,
    })
  }))
}
