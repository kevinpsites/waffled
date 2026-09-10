import { isNoAnswer, markUnanswered, reportNetworkFailure, reportStatus } from './reachability'

// Shared fetch helpers for the api client. In dev, Vite proxies /api to the api
// container; in the stack, Caddy does. Auth is a JWT session: a short-lived access
// token + a rotating refresh token in localStorage (set by the login/setup flow).
// A 401 transparently refreshes once and retries; a failed refresh clears the
// session and signals the AuthGate to show the login screen.
const ACCESS_KEY = 'waffled.access'
const REFRESH_KEY = 'waffled.refresh'

// ── kiosk device layer ─────────────────────────────────────────────────────────
// A paired tablet stores a long-lived device secret (persists across profile
// switches and idle) and a short-lived device access token minted from it. The
// access/refresh keys above are reused for the *currently claimed profile* — an
// ephemeral session cleared on switch/idle while the device stays paired.
const DEVICE_SECRET_KEY = 'waffled.kiosk.deviceSecret'
const DEVICE_ID_KEY = 'waffled.kiosk.deviceId'
const DEVICE_ACCESS_KEY = 'waffled.kiosk.deviceAccess'
const KIOSK_MODE_KEY = 'waffled.kiosk.mode'      // device is paired (→ profile picker)
const DISPLAY_MODE_KEY = 'waffled.kiosk.display' // this browser is the always-on display

export function isKioskMode(): boolean {
  try {
    return localStorage.getItem(KIOSK_MODE_KEY) === '1'
  } catch {
    return false
  }
}

// "Display mode" = ambient family display (screensaver, keep-awake). Per-device,
// separate from pairing — a single-account family can turn it on, and a dev browser
// leaves it off so nothing fires. Pairing implies display mode.
export function isDisplayMode(): boolean {
  try {
    if (localStorage.getItem(DISPLAY_MODE_KEY) === '1') return true
  } catch {
    /* ignore */
  }
  return isKioskMode()
}
export function setDisplayMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(DISPLAY_MODE_KEY, '1')
    else localStorage.removeItem(DISPLAY_MODE_KEY)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('waffled:auth-changed'))
}
export function getDeviceId(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_ID_KEY) || undefined
  } catch {
    return undefined
  }
}
function getDeviceSecret(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_SECRET_KEY) || undefined
  } catch {
    return undefined
  }
}
function getDeviceToken(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_ACCESS_KEY) || undefined
  } catch {
    return undefined
  }
}
// Store the paired device (secret + id + kiosk-mode flag) WITHOUT navigating, so the
// pairing screen can run its post-pair "name this kiosk" step first. The device token
// works immediately (the secret is stored). Call enterKioskMode() to actually proceed.
export function setKioskDevice(deviceSecret: string, deviceId: string): void {
  try {
    localStorage.setItem(DEVICE_SECRET_KEY, deviceSecret)
    localStorage.setItem(DEVICE_ID_KEY, deviceId)
    localStorage.setItem(KIOSK_MODE_KEY, '1')
  } catch {
    /* ignore */
  }
}
// Re-resolve the AuthGate now that the device is paired → the profile picker (or, if
// an admin is still signed in on this browser, just refreshes their session chrome).
export function enterKioskMode(): void {
  window.dispatchEvent(new Event('waffled:auth-changed'))
}
// Unpair entirely (admin revoked the device, or the operator un-kiosks it): drop
// the device + any profile session → back to the normal login screen.
export function clearKioskDevice(): void {
  try {
    for (const k of [DEVICE_SECRET_KEY, DEVICE_ID_KEY, DEVICE_ACCESS_KEY, KIOSK_MODE_KEY, ACCESS_KEY, REFRESH_KEY]) {
      localStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('waffled:auth-changed'))
}
// End just the claimed-profile session (switch profile / idle), keeping the device
// paired. The AuthGate re-resolves to the picker because kiosk mode is still on.
export function clearProfileSession(): void {
  try {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('waffled:auth-changed'))
}

// The person whose session is currently active (the claimed kiosk profile, or the
// logged-in user) — used to decide whose PERSONAL calendar events are visible on
// this device right now. null = no profile claimed (a bare kiosk) → family only.
// Kept in a module so the offline agenda reads (events-local) can filter locally
// without every call site threading it through; useHousehold() keeps it current.
let viewerPersonId: string | null = null
export function currentViewerPersonId(): string | null {
  return viewerPersonId
}
export function setCurrentViewerPersonId(id: string | null): void {
  viewerPersonId = id
}

export function getAccessToken(): string | undefined {
  try {
    return localStorage.getItem(ACCESS_KEY) || localStorage.getItem('waffled.token') || undefined
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
    localStorage.removeItem('waffled.token') // retire the legacy dev key
  } catch {
    /* localStorage unavailable */
  }
  window.dispatchEvent(new Event('waffled:auth-changed'))
}
export function clearSession(): void {
  try {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem('waffled.token')
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('waffled:auth-changed'))
}

// Every request doubles as a reachability sample (see ./reachability): the store
// needs to hear the answers as well as the silences, and a rejected fetch is tagged
// so a caller can tell "the server never answered" from "the server said no". A
// caller's own abort is neither, so it reports nothing.
export async function trackedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    const res = await fetch(path, init)
    reportStatus(res.status, res.headers?.get('content-type'))
    return res
  } catch (err) {
    if (init.signal?.aborted) throw err
    reportNetworkFailure()
    throw markUnanswered(err)
  }
}

// A proxy answering for an api that didn't gets the same "no answer" tag a rejected
// fetch does — but only when the body isn't the api's own JSON (see isNoAnswer).
function tagIfGateway<E>(err: E, res: Response): E {
  return isNoAnswer(res.status, res.headers?.get('content-type')) ? markUnanswered(err) : err
}

// Single in-flight refresh shared across concurrent 401s.
let refreshing: Promise<boolean> | null = null
function refreshSession(): Promise<boolean> {
  const rt = getRefreshToken()
  if (!rt) return Promise.resolve(false)
  if (!refreshing) {
    refreshing = trackedFetch('/api/auth/refresh', {
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

// A lost session drops to the profile picker in kiosk mode (device stays paired),
// or to the login screen otherwise.
function endLostSession(): void {
  if (isKioskMode()) clearProfileSession()
  else clearSession()
}

// A 403 that no session can ever satisfy: the household the token names is gone (a
// restored database, a deleted household, a rebuilt stack), so refreshing only mints
// another token for the same hole. Keyed on the server's `NoHousehold` code — never on
// the bare status and never on the message, because an ordinary permission denial is a
// 403 too and signing somebody out for lacking a capability would be worse than the
// stuck session this ends.
async function householdIsGone(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: unknown } | null
    return body?.error === 'NoHousehold'
  } catch {
    return false // an unreadable body is not evidence of anything
  }
}

// fetch with the bearer token + one transparent refresh-and-retry on 401.
async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const withAuth = (tok?: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  let res = await trackedFetch(path, withAuth(getAccessToken()))
  if (res.status === 401 && getRefreshToken()) {
    if (await refreshSession()) {
      res = await trackedFetch(path, withAuth(getAccessToken()))
    } else {
      endLostSession() // refresh failed → picker (kiosk) or login
    }
  } else if (res.status === 403 && (await householdIsGone(res))) {
    endLostSession() // the household is gone → picker (kiosk) or login
  }
  return res
}

// ── device-token fetch (kiosk pre-profile calls) ───────────────────────────────
// Single in-flight device-token refresh, minted from the stored device secret.
let refreshingDevice: Promise<boolean> | null = null
function refreshDeviceToken(): Promise<boolean> {
  const secret = getDeviceSecret()
  if (!secret) return Promise.resolve(false)
  if (!refreshingDevice) {
    refreshingDevice = trackedFetch('/api/kiosk/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceSecret: secret }),
    })
      .then(async (res) => {
        if (!res.ok) return false
        const d = (await res.json()) as { accessToken: string }
        try {
          localStorage.setItem(DEVICE_ACCESS_KEY, d.accessToken)
        } catch {
          /* ignore */
        }
        return true
      })
      .catch(() => false)
      .finally(() => {
        refreshingDevice = null
      })
  }
  return refreshingDevice
}

// fetch with the device bearer (mints one if missing) + one refresh-and-retry on
// 401. A failed device refresh means the device was revoked → unpair.
export async function deviceFetch(path: string, init: RequestInit): Promise<Response> {
  const withAuth = (tok?: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  let tok = getDeviceToken()
  if (!tok) {
    await refreshDeviceToken()
    tok = getDeviceToken()
  }
  let res = await trackedFetch(path, withAuth(tok))
  if (res.status === 401) {
    if (await refreshDeviceToken()) {
      res = await trackedFetch(path, withAuth(getDeviceToken()))
    } else {
      clearKioskDevice() // device revoked → back to login
    }
  }
  return res
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await authFetch(path, {})
  if (!res.ok) throw tagIfGateway(new Error(`${path} -> ${res.status}`), res)
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

// Thrown by apiSend on a non-2xx. Keeps the same `${method} ${path} -> ${status}`
// message (so existing `.catch(() => …)` callers are unaffected), and additionally
// carries the HTTP status + parsed JSON body so callers that want to surface the
// server's `{ error, message }` can read `err.status` / `err.body`.
export class ApiSendError extends Error {
  status: number
  body: { error?: string; message?: string } & Record<string, unknown>
  constructor(method: string, path: string, status: number, body: Record<string, unknown>) {
    super(`${method} ${path} -> ${status}`)
    this.name = 'ApiSendError'
    this.status = status
    this.body = body
  }
}

export async function apiSend<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw tagIfGateway(new ApiSendError(method, path, res.status, errBody), res)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  const res = await authFetch(path, { method: 'DELETE' })
  if (!res.ok) throw tagIfGateway(new Error(`DELETE ${path} -> ${res.status}`), res)
}

// Local YYYY-MM-DD (kiosk timezone), used to match "tonight" and window the week.
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
