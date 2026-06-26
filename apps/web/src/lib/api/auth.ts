// Auth flow — login / first-run setup / logout. These hit the public auth
// endpoints directly (no bearer) and persist the returned session via setSession,
// which signals the AuthGate to render the app.
import { apiGet, apiSend, setSession, clearSession } from './client'

export interface AuthStatus {
  initialized: boolean
  methods: string[]
  oidc?: { buttonLabel: string }
}
interface SessionResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  person?: unknown
  household?: unknown
}
// Admin-managed OIDC config (Settings → Login & security). The client secret is
// never returned — `secretSet` reports whether one is stored.
export interface OidcConfig {
  oidcEnabled: boolean
  issuerUrl: string | null
  clientId: string | null
  secretSet: boolean
  scopes: string
  buttonLabel: string
  passwordLoginEnabled: boolean
  encryptionAvailable: boolean
}
export interface OidcConfigPatch {
  oidcEnabled?: boolean
  issuerUrl?: string | null
  clientId?: string | null
  clientSecret?: string | null // omit to keep, "" to clear
  scopes?: string
  buttonLabel?: string
  passwordLoginEnabled?: boolean
}
export interface SetupInput {
  household: { name: string; timezone: string }
  admin: { name: string; email: string; password: string; avatarEmoji?: string | null; colorHex?: string | null }
}

async function post(path: string, body: unknown): Promise<SessionResponse> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(err.message || `Request failed (${res.status})`)
  }
  return res.json() as Promise<SessionResponse>
}

export const authApi = {
  status: () => apiGet<AuthStatus>('/api/auth/status'),
  async login(email: string, password: string): Promise<void> {
    const d = await post('/api/auth/login', { email, password })
    setSession(d.accessToken, d.refreshToken)
  },
  async setup(input: SetupInput): Promise<void> {
    const d = await post('/api/auth/setup', input)
    setSession(d.accessToken, d.refreshToken)
  },
  // Full-page handoff to the backend OIDC flow; it redirects back to /auth/callback.
  startOidc(): void {
    window.location.href = `/api/auth/oidc/start?redirect=${encodeURIComponent(window.location.origin + '/')}`
  },
  // /auth/callback exchanges the one-time handoff code for a real session.
  async oidcExchange(code: string): Promise<void> {
    const d = await post('/api/auth/oidc/exchange', { code })
    setSession(d.accessToken, d.refreshToken)
  },
  // Admin OIDC config (authed; routes require admin).
  getConfig: () => apiGet<OidcConfig>('/api/auth/config'),
  saveConfig: (patch: OidcConfigPatch) => apiSend<{ ok: true }>('PUT', '/api/auth/config', patch),
  testConfig: (issuerUrl: string) =>
    apiSend<{ ok: boolean; issuer?: string; authorizationEndpoint?: string; message?: string }>('POST', '/api/auth/config/test', { issuerUrl }),
  // Mint a fresh session for another household this account belongs to. The caller
  // decides what to do next (we do a full reload to re-establish PowerSync etc.).
  async switchHousehold(householdId: string): Promise<void> {
    const d = await apiSend<SessionResponse>('POST', '/api/auth/switch', { householdId })
    setSession(d.accessToken, d.refreshToken)
  },
  // Accept a pending invitation — creates the membership (no auto-switch).
  async acceptInvite(inviteId: string): Promise<void> {
    await apiSend('POST', `/api/auth/invites/${inviteId}/accept`, {})
  },
  async logout(): Promise<void> {
    let refreshToken: string | undefined
    try {
      refreshToken = localStorage.getItem('nook.refresh') || undefined
    } catch {
      /* ignore */
    }
    if (refreshToken) {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) }).catch(() => {})
    }
    clearSession()
  },
}
