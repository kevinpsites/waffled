// AI app connections (MCP connectors signing in over OAuth). The consent screen reads and
// answers an authorization request; Settings → Connected apps lists and revokes grants.
// The server validates every request and builds every redirect, so the client never
// sends the browser to a URL it assembled itself.
import { apiSend, apiDelete, ApiSendError } from './client'

export interface ConsentScope {
  scope: string
  description: string
  write: boolean
}

export interface ConsentInfo {
  client: { id: string; name: string; redirectHost: string }
  scopes: ConsentScope[]
  households: { id: string; name: string; canConnect: boolean }[]
}

// A request the server refused. `redirect` is set only when the client and its
// redirect_uri checked out, so the error may be handed back to the app.
export interface ConsentError {
  error: string
  description: string
  redirect?: string
}

export interface ConnectedApp {
  id: string
  clientId: string
  clientName: string
  redirectHost: string
  scopes: string[]
  householdId: string
  householdName: string
  createdAt: string
  lastUsedAt: string | null
}

function asConsentError(err: unknown): ConsentError | null {
  if (!(err instanceof ApiSendError) || typeof err.body.error !== 'string') return null
  return {
    error: err.body.error,
    description: String(err.body.error_description ?? err.body.message ?? err.body.error),
    redirect: typeof err.body.redirect === 'string' ? err.body.redirect : undefined,
  }
}

export const oauthApi = {
  // `search` is the /oauth/authorize query string, forwarded verbatim.
  async consentInfo(search: string): Promise<ConsentInfo | ConsentError> {
    try {
      return await apiSend<ConsentInfo>('GET', `/api/oauth/authorize/info${search}`)
    } catch (err) {
      const e = asConsentError(err)
      if (e) return e
      throw err
    }
  },
  // Approve or decline; answers the URL to leave for.
  async decide(
    params: Record<string, string>,
    answer: { decision: 'approve'; householdId: string; scopes: string[] } | { decision: 'deny' }
  ): Promise<{ redirect: string } | ConsentError> {
    try {
      return await apiSend<{ redirect: string }>('POST', '/api/oauth/authorize', { ...params, ...answer })
    } catch (err) {
      const e = asConsentError(err)
      if (e) return e
      throw err
    }
  },
  listGrants: () =>
    apiSend<{ grants: ConnectedApp[]; scopeDescriptions: Record<string, string> }>('GET', '/api/oauth/grants'),
  revokeGrant: (id: string) => apiDelete(`/api/oauth/grants/${id}`),
}
