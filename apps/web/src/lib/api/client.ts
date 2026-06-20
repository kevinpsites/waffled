// Shared fetch helpers for the api client. In dev, Vite proxies /api to the api
// container; in the stack, Caddy does. Auth is a JWT session: a short-lived access
// token + a rotating refresh token in localStorage (set by the login/setup flow).
// A 401 transparently refreshes once and retries; a failed refresh clears the
// session and signals the AuthGate to show the login screen.
const ACCESS_KEY = 'nook.access'
const REFRESH_KEY = 'nook.refresh'

export function getAccessToken(): string | undefined {
  try {
    return localStorage.getItem(ACCESS_KEY) || localStorage.getItem('nook.token') || undefined
  } catch {
    return import.meta.env.VITE_KIOSK_TOKEN || undefined
  }
}
function getRefreshToken(): string | undefined {
  try {
    return localStorage.getItem(REFRESH_KEY) || undefined
  } catch {
    return undefined
  }
}
export function setSession(accessToken: string, refreshToken: string): void {
  try {
    localStorage.setItem(ACCESS_KEY, accessToken)
    localStorage.setItem(REFRESH_KEY, refreshToken)
    localStorage.removeItem('nook.token') // retire the legacy dev key
  } catch {
    /* localStorage unavailable */
  }
  window.dispatchEvent(new Event('nook:auth-changed'))
}
export function clearSession(): void {
  try {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem('nook.token')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('nook:auth-changed'))
}

// Single in-flight refresh shared across concurrent 401s.
let refreshing: Promise<boolean> | null = null
function refreshSession(): Promise<boolean> {
  const rt = getRefreshToken()
  if (!rt) return Promise.resolve(false)
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    })
      .then(async (res) => {
        if (!res.ok) return false
        const d = (await res.json()) as { accessToken: string; refreshToken: string }
        try {
          localStorage.setItem(ACCESS_KEY, d.accessToken)
          localStorage.setItem(REFRESH_KEY, d.refreshToken)
        } catch {
          /* ignore */
        }
        return true
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null
      })
  }
  return refreshing
}

// fetch with the bearer token + one transparent refresh-and-retry on 401.
async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const withAuth = (tok?: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  let res = await fetch(path, withAuth(getAccessToken()))
  if (res.status === 401 && getRefreshToken()) {
    if (await refreshSession()) {
      res = await fetch(path, withAuth(getAccessToken()))
    } else {
      clearSession() // refresh failed → back to login
    }
  }
  return res
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await authFetch(path, {})
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

// Short-lived GET cache for idempotent, expensive reads (e.g. the AI cards): a
// mount within the TTL reuses the in-flight/last promise instead of firing the
// same request again — so navigating away and back doesn't re-run the model. A
// failed request is evicted so the next mount retries.
const getCache = new Map<string, { at: number; p: Promise<unknown> }>()
export function apiGetCached<T>(path: string, ttlMs: number): Promise<T> {
  const hit = getCache.get(path)
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>
  const p = apiGet<T>(path)
  getCache.set(path, { at: Date.now(), p })
  p.catch(() => { if (getCache.get(path)?.p === p) getCache.delete(path) })
  return p
}
// Drop cached GETs by path prefix (e.g. after editing an event) so the next read is fresh.
export function invalidateGetCache(prefix: string): void {
  for (const k of [...getCache.keys()]) if (k.startsWith(prefix)) getCache.delete(k)
}

export async function apiSend<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  const res = await authFetch(path, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`)
}

// Local YYYY-MM-DD (kiosk timezone), used to match "tonight" and window the week.
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
