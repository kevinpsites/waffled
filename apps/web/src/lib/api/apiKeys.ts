// Per-user API keys: mint a long-lived secret (shown once) that external tools use
// via the `x-api-key` header instead of a session. The grantable scope catalog is
// fetched from the server so the create UI never drifts from what the API enforces.
import { apiGet, apiSend, apiDelete } from './client'

export interface ApiScopeDef {
  resource: string
  label: string
  description: string
  prefixes: string[]
  readOnly?: boolean
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface CreateApiKeyInput {
  name: string
  scopes: string[]
  expiresAt?: string | null
}

export const apiKeysApi = {
  // The grantable scope catalog (resource families + which expose writes).
  listScopes: () => apiGet<{ scopes: ApiScopeDef[] }>('/api/api-keys/scopes').then((r) => r.scopes),
  // The caller's own keys (metadata only — the secret is never retrievable).
  list: () => apiGet<{ keys: ApiKey[] }>('/api/api-keys').then((r) => r.keys),
  // Returns the full secret exactly once, in `key`.
  create: (input: CreateApiKeyInput) => apiSend<{ key: string; apiKey: ApiKey }>('POST', '/api/api-keys', input),
  revoke: (id: string) => apiDelete(`/api/api-keys/${id}`),
}
