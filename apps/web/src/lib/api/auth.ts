// Auth flow — login / first-run setup / logout. These hit the public auth
// endpoints directly (no bearer) and persist the returned session via setSession,
// which signals the AuthGate to render the app.
import { apiGet, setSession, clearSession } from './client'

export interface AuthStatus {
  initialized: boolean
  methods: string[]
}
interface SessionResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  person?: unknown
  household?: unknown
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
