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
import { requireTenant } from '../households/households'

type Api = ReturnType<typeof createAPI>

const ISSUER = 'nook'
const AUDIENCE = 'powersync'
const KID = process.env.POWERSYNC_JWT_KID ?? 'nook-powersync-1'
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
    const pem = process.env.POWERSYNC_JWT_PRIVATE_KEY
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

export function registerPowerSyncRoutes(api: Api): void {
  // Public: PowerSync fetches this to validate client tokens.
  api.get('/api/auth/keys', async () => getJwks())

  // Authed: a provisioned member exchanges their session for a PowerSync token.
  api.get('/api/powersync/token', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const token = mintPowerSyncToken(tenant.sub, tenant.householdId)
    return res.status(200).json({
      token,
      powerSyncUrl: process.env.POWERSYNC_PUBLIC_URL ?? null,
      expiresIn: TOKEN_TTL_SECONDS,
    })
  })
}
