// Access tokens for MCP connector grants. Same secret and issuer as a user session, but the
// audience is the MCP resource URL (`<origin>/mcp`), so requireAuth — which pins the user
// audience — rejects one on every REST route with no further code. Kept apart from
// mintAccess on purpose: that one must keep minting exactly what requireAuth accepts.
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { config } from '../../platform/config'
import { AuthError } from '../../platform/auth'

const MCP_ACCESS_TTL_SECONDS = Number(process.env.MCP_ACCESS_TOKEN_TTL_SECONDS) || 60 * 60

export interface McpAccessInput {
  accountId: string
  householdId: string
  resource: string
  scopes: string[]
  grantId: string
  clientId: string
}

export function mintMcpAccess(input: McpAccessInput): { token: string; expiresIn: number } {
  const { secret, issuer } = config.auth.local
  const token = jwt.sign(
    {
      [config.auth.householdClaim]: input.householdId,
      scope: input.scopes.join(' '),
      grant_id: input.grantId,
      client_id: input.clientId,
    },
    secret,
    { algorithm: 'HS256', subject: input.accountId, issuer, audience: input.resource, expiresIn: MCP_ACCESS_TTL_SECONDS }
  )
  return { token, expiresIn: MCP_ACCESS_TTL_SECONDS }
}

// Routing only, never trust: a token claiming a grant goes to the grant verifier, which
// checks the signature and audience. Anything else takes the normal user path.
export function claimsGrant(token: string): boolean {
  const decoded = jwt.decode(token)
  return typeof decoded === 'object' && decoded !== null && typeof decoded.grant_id === 'string'
}

export function verifyMcpAccess(token: string, resource: string): JwtPayload & { grant_id: string; scope: string } {
  const { secret, issuer } = config.auth.local
  let claims: JwtPayload
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer, audience: resource }) as JwtPayload
  } catch (err) {
    throw new AuthError(`Invalid token: ${(err as Error).message}`)
  }
  if (!claims.sub || typeof claims.grant_id !== 'string' || typeof claims.scope !== 'string') {
    throw new AuthError('Invalid token: not an MCP grant token')
  }
  return claims as JwtPayload & { grant_id: string; scope: string }
}
