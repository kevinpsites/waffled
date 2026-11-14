// OAuth discovery for MCP connectors: protected-resource metadata (RFC 9728) and
// authorization-server metadata (RFC 8414). Every URL is built from this request's origin
// (PUBLIC_BASE_URL, else the forwarded host/proto, the same rule OIDC uses), so the
// resource a token is bound to is the exact URL the client reached /mcp at.
import createAPI, { type Request, type Response } from 'lambda-api'
import { baseUrl } from '../auth/oidc'
import { toolRegistry } from '../mcp/registry'
import '../mcp/tools'

type Api = ReturnType<typeof createAPI>

export const MCP_RESOURCE_PATH = '/mcp'
const PRM_PATH = '/.well-known/oauth-protected-resource'
const AS_PATH = '/.well-known/oauth-authorization-server'

export function issuerUrl(req: Request): string {
  return new URL(baseUrl(req)).origin
}

export function mcpResource(req: Request): string {
  return `${issuerUrl(req)}${MCP_RESOURCE_PATH}`
}

// RFC 8707 canonical form: lowercase scheme and host (URL does both), no default port, no
// trailing slash, no query or fragment. null for anything that is not an absolute URL.
export function canonicalResource(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.search || u.hash) return null
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.origin}${path}`
  } catch {
    return null
  }
}

// Only scopes some tool declares are ever offered: a scope no tool uses would grant
// nothing, since an MCP token reaches nothing but /mcp.
export function mcpScopes(): string[] {
  return [...new Set(toolRegistry().map((t) => t.scope))].sort()
}

// What each scope lets an AI app do, in the words the consent screen shows.
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'family:read': 'See your household and its members',
  'lists:read': 'See the grocery list and your other lists',
  'lists:write': 'Add, check off and remove list items',
  'pantry:read': 'See what is in the pantry',
  'pantry:write': 'Change what is in the pantry',
  'chores:read': 'See chores and who has done them',
  'chores:write': 'Add, complete and reassign chores',
  'rewards:read': 'See reward balances',
  'rewards:write': 'Redeem rewards',
  'meals:read': 'See the meal plan and recipes',
  'meals:write': 'Plan meals',
  'calendar:read': 'See the family calendar',
  'calendar:write': 'Add, move and cancel calendar events',
  'goals:read': 'See goals and progress',
  'goals:write': 'Log progress on goals',
  'photos:read': 'See photos',
  'photos:write': 'Add and change photos',
  'weather:read': 'See the local weather',
}

// The challenge a 401 from /mcp carries. Claude reads it only on a 401.
export function wwwAuthenticate(req: Request, invalidToken: boolean): string {
  const parts = [
    ...(invalidToken ? ['error="invalid_token"'] : []),
    `resource_metadata="${issuerUrl(req)}${PRM_PATH}${MCP_RESOURCE_PATH}"`,
    `scope="${mcpScopes().join(' ')}"`,
  ]
  return `Bearer ${parts.join(', ')}`
}

export const OAUTH_DISCOVERY_PATHS = [PRM_PATH, `${PRM_PATH}${MCP_RESOURCE_PATH}`, AS_PATH]

export function registerOAuthMetadataRoutes(api: Api): void {
  const protectedResource = (req: Request, res: Response) =>
    res.status(200).json({
      resource: mcpResource(req),
      authorization_servers: [issuerUrl(req)],
      scopes_supported: mcpScopes(),
      bearer_methods_supported: ['header'],
      resource_name: 'Waffled',
    })
  api.get(PRM_PATH, protectedResource)
  api.get(`${PRM_PATH}${MCP_RESOURCE_PATH}`, protectedResource)

  api.get(AS_PATH, (req: Request, res: Response) => {
    const origin = issuerUrl(req)
    return res.status(200).json({
      issuer: origin,
      // A web SPA route: sign-in and consent happen in the normal Waffled app.
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: mcpScopes(),
    })
  })
}
