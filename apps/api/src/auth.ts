import jwt, { type JwtPayload, type GetPublicKeyOrSecret } from 'jsonwebtoken'
import { JwksClient } from 'jwks-rsa'
import type { Request } from 'lambda-api'
import { config } from './config'

export interface AuthContext {
  sub?: string
  householdId: string
  claims: JwtPayload
}

// Hang the tenant context off the lambda-api Request so routes can read req.tenant.
// (lambda-api already owns req.auth — its parsed Authorization header.)
declare module 'lambda-api' {
  interface Request {
    tenant?: AuthContext
  }
}

// Thrown for any auth failure; carries the HTTP status the error handler renders.
export class AuthError extends Error {
  statusCode: number
  constructor(message: string, status = 401) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = status
  }
}

// Built on first use, only in auth0 mode — local mode never opens the JWKS client.
let jwksClient: JwksClient | null = null
function auth0KeyResolver(): GetPublicKeyOrSecret {
  if (!jwksClient) {
    jwksClient = new JwksClient({
      jwksUri: config.auth.auth0.jwksUri ?? '',
      cache: true,
      rateLimit: true,
    })
  }
  const client = jwksClient
  return (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err || !key) return callback(err ?? new Error('No signing key'))
      callback(null, key.getPublicKey())
    })
  }
}

function verifyToken(token: string): Promise<JwtPayload> {
  if (config.auth.mode === 'local') {
    const { secret, issuer, audience } = config.auth.local
    return Promise.resolve(
      jwt.verify(token, secret, { algorithms: ['HS256'], issuer, audience }) as JwtPayload
    )
  }
  const { issuer, audience } = config.auth.auth0
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      auth0KeyResolver(),
      {
        algorithms: ['RS256'],
        issuer: issuer ?? undefined,
        audience: audience ?? undefined,
      },
      (err, decoded) => (err ? reject(err) : resolve(decoded as JwtPayload))
    )
  })
}

function bearerToken(req: Request): string {
  // lambda-api parses the Authorization header into req.auth.
  if (req.auth?.type === 'Bearer' && req.auth.value) return req.auth.value
  throw new AuthError('Missing Bearer token')
}

// Verifies the token and populates req.tenant. Every protected route can then
// trust req.tenant.householdId.
export async function requireAuth(req: Request): Promise<void> {
  let claims: JwtPayload
  try {
    claims = await verifyToken(bearerToken(req))
  } catch (err) {
    if (err instanceof AuthError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new AuthError(`Invalid token: ${message}`)
  }
  const householdId = claims[config.auth.householdClaim] as string | undefined
  if (!householdId) throw new AuthError('Token missing household_id claim', 403)
  req.tenant = { sub: claims.sub, householdId, claims }
}
