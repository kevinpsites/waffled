// Shared fetch helpers for the api client. In dev, Vite proxies /api to the api
// container; in the stack, Caddy does. Auth is a JWT session: a short-lived access
// token + a rotating refresh token in localStorage (set by the login/setup flow).
// A 401 transparently refreshes once and retries; a failed refresh clears the
// session and signals the AuthGate to show the login screen.
import {
  broadcastPrincipalTransitionFinished,
  broadcastPrincipalTransitionStarted,
  transitionPrincipal,
  withSessionRefreshLock,
  type PrincipalTransitionPolicy,
  type PrincipalTransitionResult,
} from '../powersync/principal-transition'

const ACCESS_KEY = 'waffled.access'
const REFRESH_KEY = 'waffled.refresh'
const SESSION_SCOPE_KEY = 'waffled.sessionScope'
const SESSION_KEY = 'waffled.session.v1'
const VIEWER_MEMBER_TYPE_KEY = 'waffled.currentMemberType'
const VIEWER_MEMBER_TYPE_SCOPE_KEY = 'waffled.currentMemberTypeScope'
const BUILTIN_MEMBER_TYPES = new Set(['adult', 'caregiver', 'guest', 'teen', 'kid'])

// Short-lived GETs can contain household-private generated content. Keep the
// cache in the same identity boundary as the viewer metadata so a login,
// household switch, or kiosk profile switch can never reuse the prior
// principal's response.
const getCache = new Map<string, { at: number; p: Promise<unknown> }>()

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

interface StoredSession {
  v: 1
  scope: string
  accessToken: string
  refreshToken: string
}

interface SignedOutSession {
  v: 1
  signedOut: true
}

// undefined = no atomic record yet (legacy migration is allowed); null = a
// malformed atomic record (fail signed-out and never revive older split keys).
function parsedSessionRecord(): StoredSession | SignedOutSession | null | undefined {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw === null) return undefined
    const value = JSON.parse(raw) as Partial<StoredSession & SignedOutSession>
    if (value.v !== 1) return null
    if (value.signedOut === true) return { v: 1, signedOut: true }
    if (typeof value.scope !== 'string' || !value.scope ||
        typeof value.accessToken !== 'string' || !value.accessToken ||
        typeof value.refreshToken !== 'string' || !value.refreshToken) return null
    return {
      v: 1,
      scope: value.scope,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
    }
  } catch {
    return null
  }
}

function removeLegacySessionKeys(): void {
  for (const key of [ACCESS_KEY, REFRESH_KEY, SESSION_SCOPE_KEY]) {
    try { localStorage.removeItem(key) } catch { /* best effort after atomic commit */ }
  }
}

function resolvedSessionRecord(): StoredSession | SignedOutSession | null {
  const record = parsedSessionRecord()
  if (record !== undefined) return record ?? { v: 1, signedOut: true }

  // One-time migration from the old three-key representation. A partial legacy
  // pair is rejected rather than recombined across identities.
  try {
    const accessToken = localStorage.getItem(ACCESS_KEY)
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    if (!accessToken || !refreshToken) return null
    const migrated: StoredSession = {
      v: 1,
      scope: localStorage.getItem(SESSION_SCOPE_KEY) || freshSessionScope(),
      accessToken,
      refreshToken,
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(migrated))
    removeLegacySessionKeys()
    return migrated
  } catch {
    return null
  }
}

interface AuthSessionSnapshot {
  identityScope: string | null
  accessToken: string | undefined
  refreshToken: string | undefined
}

// Read the atomic record exactly once when dispatching an authenticated request.
// That prevents a cross-tab A -> B commit from combining A's captured generation
// with B's bearer token across separate localStorage reads.
function authSessionSnapshot(): AuthSessionSnapshot {
  const record = resolvedSessionRecord()
  if (record && !('signedOut' in record)) {
    return {
      identityScope: `session:${record.scope}`,
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
    }
  }
  try {
    const devToken = record ? null : localStorage.getItem('waffled.token')
    const accessToken = devToken || import.meta.env.VITE_KIOSK_TOKEN || undefined
    return {
      identityScope: devToken ? `dev:${devToken}` : null,
      accessToken,
      refreshToken: undefined,
    }
  } catch {
    return {
      identityScope: null,
      accessToken: import.meta.env.VITE_KIOSK_TOKEN || undefined,
      refreshToken: undefined,
    }
  }
}

function storeSession(accessToken: string, refreshToken: string, scope = freshSessionScope()): void {
  const record: StoredSession = { v: 1, scope, accessToken, refreshToken }
  // One synchronous set is the credential commit point: a crash cannot combine
  // one principal's access token with another principal's refresh token.
  localStorage.setItem(SESSION_KEY, JSON.stringify(record))
  removeLegacySessionKeys()
}

function storeSignedOutSession(): void {
  // Keep a tombstone instead of merely removing the record. If cleanup is
  // interrupted, stale legacy keys cannot be migrated back into a live session.
  localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 1, signedOut: true } satisfies SignedOutSession))
  removeLegacySessionKeys()
}

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
export async function clearKioskDevice(): Promise<void> {
  await changePrincipal('discard-authorized', 'signed-out', () => {
    clearCurrentViewerIdentity()
    storeSignedOutSession()
    try {
      for (const k of [DEVICE_SECRET_KEY, DEVICE_ID_KEY, DEVICE_ACCESS_KEY, KIOSK_MODE_KEY, 'waffled.token']) {
        localStorage.removeItem(k)
      }
    } catch {
      /* ignore */
    }
  })
}
// End just the claimed-profile session (switch profile / idle), keeping the device
// paired. The AuthGate re-resolves to the picker because kiosk mode is still on.
export async function clearProfileSession(opts: { discardPending?: boolean } = {}): Promise<void> {
  await changePrincipal(
    opts.discardPending ? 'discard-authorized' : 'require-no-pending',
    'signed-out',
    () => {
      clearCurrentViewerIdentity()
      storeSignedOutSession()
    }
  )
}

// The person whose session is currently active (the claimed kiosk profile, or the
// logged-in user) — used to decide whose PERSONAL calendar events are visible on
// this device right now. null = no profile claimed (a bare kiosk) → family only.
// Kept in a module so the offline agenda reads (events-local) can filter locally
// without every call site threading it through; useHousehold() keeps it current.
let viewerPersonId: string | null = null

function freshSessionScope(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  } catch {
    /* older embedded browsers */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// localStorage is origin-scoped, so an ordinary deployment cannot carry this
// cache to another server. A random generation distinguishes explicit login,
// household-switch, and kiosk-profile sessions while surviving access-token
// refresh and cold offline launches. That also lets identity loaders reject a
// delayed response from the session they replaced.
export function currentIdentityScope(): string | null {
  return authSessionSnapshot().identityScope
}

function loadCurrentViewerMemberType(): string | null {
  try {
    const memberType = localStorage.getItem(VIEWER_MEMBER_TYPE_KEY)
    const scope = currentIdentityScope()
    if (memberType && BUILTIN_MEMBER_TYPES.has(memberType) && scope &&
        localStorage.getItem(VIEWER_MEMBER_TYPE_SCOPE_KEY) === scope) return memberType
    localStorage.removeItem(VIEWER_MEMBER_TYPE_KEY)
    localStorage.removeItem(VIEWER_MEMBER_TYPE_SCOPE_KEY)
  } catch {
    /* localStorage unavailable */
  }
  return null
}

let viewerMemberType: string | null = loadCurrentViewerMemberType()
export function currentViewerPersonId(): string | null {
  return viewerPersonId
}
export function setCurrentViewerPersonId(id: string | null): void {
  viewerPersonId = id
}
export function setCurrentViewerMemberType(memberType: string | null): void {
  const trusted = memberType && BUILTIN_MEMBER_TYPES.has(memberType) ? memberType : null
  viewerMemberType = trusted
  try {
    const scope = currentIdentityScope()
    if (trusted && scope) {
      localStorage.setItem(VIEWER_MEMBER_TYPE_KEY, trusted)
      localStorage.setItem(VIEWER_MEMBER_TYPE_SCOPE_KEY, scope)
    } else {
      localStorage.removeItem(VIEWER_MEMBER_TYPE_KEY)
      localStorage.removeItem(VIEWER_MEMBER_TYPE_SCOPE_KEY)
    }
  } catch {
    /* localStorage unavailable */
  }
}

function clearCurrentViewerIdentity(): void {
  setCurrentViewerPersonId(null)
  setCurrentViewerMemberType(null)
  getCache.clear()
}

// Local PowerSync writes must fail closed until /api/household has identified a
// built-in role. Otherwise a guest (or a stale/custom role the clients do not
// understand) can optimistically mutate SQLite and leave a rejected write at the
// head of the durable upload queue.
export function powerSyncMutationAllowed(memberType: string | null = viewerMemberType): boolean {
  return memberType === 'adult' || memberType === 'caregiver' || memberType === 'teen' || memberType === 'kid'
}

export function getAccessToken(): string | undefined {
  return authSessionSnapshot().accessToken
}
function getRefreshToken(): string | undefined {
  return authSessionSnapshot().refreshToken
}
export function getSessionRefreshToken(): string | undefined {
  return getRefreshToken()
}
export class PrincipalTransitionError extends Error {
  constructor(readonly result: Exclude<PrincipalTransitionResult, 'completed'>) {
    super(
      result === 'pending-uploads'
        ? 'Unsynced changes must finish before switching accounts.'
        : result === 'stale'
          ? 'The active session changed before the switch could finish.'
          : 'Could not clear private offline data before switching accounts.'
    )
    this.name = 'PrincipalTransitionError'
  }
}

async function changePrincipal(
  policy: PrincipalTransitionPolicy,
  replacement: 'new-principal' | 'signed-out',
  commitCredentials: () => void,
  expectation?: {
    identityScope: string | null
    stillCurrent?: () => boolean
    prepareReplacement?: () => Promise<void>
  }
): Promise<void> {
  const expectedIdentityScope = expectation
    ? expectation.identityScope
    : currentIdentityScope()
  let isolationBegan = false
  let broadcastId: string | null = null
  let result: PrincipalTransitionResult
  try {
    result = await transitionPrincipal({
      expectedIdentityScope,
      stillCurrent: expectation?.stillCurrent,
      prepareReplacement: expectation?.prepareReplacement,
      policy,
      replacement,
      beginIsolation: () => {
        if (isolationBegan) return
        isolationBegan = true
        broadcastId = broadcastPrincipalTransitionStarted()
        window.dispatchEvent(new Event('waffled:principal-transition-started'))
      },
      finishIsolation: () => {
        broadcastPrincipalTransitionFinished(broadcastId)
        broadcastId = null
      },
      commitCredentials,
    })
  } catch (error) {
    if (isolationBegan) {
      window.dispatchEvent(new Event('waffled:principal-transition-failed'))
    }
    throw error
  } finally {
    broadcastPrincipalTransitionFinished(broadcastId)
  }
  // A refused pending-write transition never hid the current principal, so do
  // not churn the auth tree (or erase its confirmation state). Once isolation
  // began, always let the gate resolve the resulting current credentials.
  if (result === 'completed' || isolationBegan) {
    window.dispatchEvent(new Event('waffled:auth-changed'))
  }
  if (result !== 'completed') throw new PrincipalTransitionError(result)
}

export async function setSession(
  accessToken: string,
  refreshToken: string,
  opts: { discardPending?: boolean } = {}
): Promise<void> {
  // With no current principal, any leftover replica is stale and its writes no
  // longer have credentials capable of uploading. An authenticated replacement
  // must instead preserve queued work unless the caller explicitly confirms loss.
  const policy: PrincipalTransitionPolicy = currentIdentityScope() && !opts.discardPending
    ? 'require-no-pending'
    : 'discard-authorized'
  await changePrincipal(policy, 'new-principal', () => {
    clearCurrentViewerIdentity()
    storeSession(accessToken, refreshToken)
    try { localStorage.removeItem('waffled.token') } catch { /* record wins */ }
  })
}

export async function setSessionFrom(
  prepare: () => Promise<{ accessToken: string; refreshToken: string }>,
  opts: { discardPending?: boolean } = {}
): Promise<void> {
  const identityScope = currentIdentityScope()
  const policy: PrincipalTransitionPolicy = identityScope && !opts.discardPending
    ? 'require-no-pending'
    : 'discard-authorized'
  let replacement: { accessToken: string; refreshToken: string } | null = null
  await changePrincipal(
    policy,
    'new-principal',
    () => {
      if (!replacement) throw new Error('Replacement credentials were not prepared')
      clearCurrentViewerIdentity()
      storeSession(replacement.accessToken, replacement.refreshToken)
      try { localStorage.removeItem('waffled.token') } catch { /* record wins */ }
    },
    {
      identityScope,
      prepareReplacement: async () => { replacement = await prepare() },
    }
  )
}
export async function clearSession(opts: { discardPending?: boolean } = {}): Promise<void> {
  await changePrincipal(
    opts.discardPending ? 'discard-authorized' : 'require-no-pending',
    'signed-out',
    () => {
      clearCurrentViewerIdentity()
      storeSignedOutSession()
      try { localStorage.removeItem('waffled.token') } catch { /* tombstone wins */ }
    }
  )
}

type RefreshResult = 'refreshed' | 'invalid' | 'inactive' | 'retryable' | 'stale'

async function responseErrorCode(response: Response): Promise<string | null> {
  if (!response.headers.get('content-type')?.includes('application/json')) return null
  try {
    const body = (await response.clone().json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

// Single in-flight refresh per identity generation. A replacement session may
// start its own refresh without waiting for (or being overwritten by) the old one.
let refreshing: {
  identityScope: string | null
  refreshToken: string
  promise: Promise<RefreshResult>
} | null = null
function refreshSession(
  identityScope: string | null,
  rt: string | undefined
): Promise<RefreshResult> {
  if (!rt) return Promise.resolve('invalid')
  if (currentIdentityScope() !== identityScope) return Promise.resolve('stale')
  if (refreshing?.identityScope === identityScope && refreshing.refreshToken === rt) {
    return refreshing.promise
  }

  let attempt: Promise<RefreshResult>
  attempt = withSessionRefreshLock(async () => {
      // Another tab may have rotated this same session while this request was
      // waiting for the origin-wide refresh lease. Reuse its result instead of
      // presenting the now-spent token to the server or signing the family out.
      if (currentIdentityScope() !== identityScope) return 'stale' as const
      const lockedRt = getRefreshToken()
      if (!lockedRt) return 'invalid' as const
      if (lockedRt !== rt) return 'refreshed' as const

      let res: Response
      try {
        res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: lockedRt }),
        })
      } catch {
        if (currentIdentityScope() !== identityScope) return 'stale' as const
        return getRefreshToken() !== lockedRt ? 'refreshed' as const : 'retryable' as const
      }

        // The request belongs to the captured generation and refresh token. An
        // explicit login/switch (or another completed rotation) makes its result
        // stale, whether it is a 200 or 401.
        if (currentIdentityScope() !== identityScope) return 'stale' as const
        if (getRefreshToken() !== lockedRt) return 'refreshed' as const
        if (!res.ok) {
          if (await responseErrorCode(res) === 'membership_inactive') return 'inactive' as const
          // A rejected refresh token is terminal. Server trouble, throttling, and
          // network loss are not: preserve the scoped offline session/data so a
          // transient outage never signs the family out or discards its queue.
          return res.status >= 400 && res.status < 500 && res.status !== 429
            ? 'invalid' as const
            : 'retryable' as const
        }
        const d = (await res.json()) as { accessToken: string; refreshToken: string }
        if (currentIdentityScope() !== identityScope) return 'stale' as const
        if (getRefreshToken() !== lockedRt) return 'refreshed' as const
        storeSession(d.accessToken, d.refreshToken, identityScope!.slice('session:'.length))
        return 'refreshed' as const
      })
      .finally(() => {
        if (refreshing?.promise === attempt) refreshing = null
      })
  refreshing = { identityScope, refreshToken: rt, promise: attempt }
  return attempt
}

// A lost session drops to the profile picker in kiosk mode (device stays paired),
// or to the login screen otherwise.
async function endLostSession(
  expectedIdentityScope: string | null,
  expectedRefreshToken: string | undefined
): Promise<void> {
  // The server rejected the only credential that could upload this queue. Privacy
  // wins over now-orphaned optimistic changes, so the old replica is force-cleared.
  // The refresh-token predicate also protects a successful same-scope rotation
  // which happened in another tab after the rejecting response arrived.
  const commitCredentials = () => {
    clearCurrentViewerIdentity()
    storeSignedOutSession()
    if (!isKioskMode()) {
      try { localStorage.removeItem('waffled.token') } catch { /* tombstone wins */ }
    }
  }
  await changePrincipal('discard-authorized', 'signed-out', commitCredentials, {
    identityScope: expectedIdentityScope,
    stillCurrent: () =>
      currentIdentityScope() === expectedIdentityScope &&
      getRefreshToken() === expectedRefreshToken,
  })
}

let endingLostSession: {
  identityScope: string | null
  refreshToken: string | undefined
  promise: Promise<void>
} | null = null

function scheduleEndLostSession(
  identityScope: string | null,
  refreshToken: string | undefined
): void {
  if (endingLostSession?.identityScope === identityScope &&
      endingLostSession.refreshToken === refreshToken) return
  let attempt: Promise<void>
  attempt = Promise.resolve()
    .then(() => endLostSession(identityScope, refreshToken))
    .catch((error) => {
      // A newer login or successful refresh won the race; that is the desired
      // outcome, not a transition failure. Anything else must stay fail-closed
      // and visible through AuthGate.
      if (error instanceof PrincipalTransitionError && error.result === 'stale') return
      window.dispatchEvent(new Event('waffled:principal-transition-failed'))
    })
    .finally(() => {
      if (endingLostSession?.promise === attempt) endingLostSession = null
    })
  endingLostSession = { identityScope, refreshToken, promise: attempt }
}

// fetch with the bearer token + one transparent refresh-and-retry on 401.
async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const withAuth = (tok?: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  const initialSession = authSessionSnapshot()
  const identityScope = initialSession.identityScope
  let refreshToken = initialSession.refreshToken
  // There is normally no yield between the atomic snapshot and dispatch, but a
  // storage implementation or test double can be re-entrant. Never send a
  // captured A action after the active generation has already become B.
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed before ${path} could be sent`)
  }
  let res = await fetch(path, withAuth(initialSession.accessToken))
  if (res.status === 401 && await responseErrorCode(res) === 'membership_inactive') {
    // This is an authoritative membership revocation/expiry, not an expired
    // access token. Do not refresh or replay the original request.
    if (currentIdentityScope() === identityScope) {
      scheduleEndLostSession(identityScope, refreshToken)
    }
    return res
  }
  if (res.status === 401 && refreshToken) {
    // A response from the replaced session must never refresh, retry a mutation,
    // or clear the credentials which replaced it.
    if (currentIdentityScope() !== identityScope) return res
    const refreshed = await refreshSession(identityScope, refreshToken)
    if (refreshed === 'refreshed' && currentIdentityScope() === identityScope) {
      const retrySession = authSessionSnapshot()
      if (retrySession.identityScope !== identityScope) return res
      refreshToken = retrySession.refreshToken
      res = await fetch(path, withAuth(retrySession.accessToken))
      // Membership can be revoked between rotating the token and replaying the
      // original request. Treat that retry as equally authoritative.
      if (res.status === 401 && await responseErrorCode(res) === 'membership_inactive' &&
          currentIdentityScope() === identityScope) {
        scheduleEndLostSession(identityScope, refreshToken)
      }
    } else if ((refreshed === 'invalid' || refreshed === 'inactive') && currentIdentityScope() === identityScope) {
      // Do not await an exclusive replica transition here. PowerSync connector
      // callbacks may be running under the shared replica lease; deferring lets
      // that callback unwind before terminal cleanup takes the exclusive lease.
      scheduleEndLostSession(identityScope, refreshToken)
    }
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
    refreshingDevice = fetch('/api/kiosk/device/token', {
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
  let res = await fetch(path, withAuth(tok))
  if (res.status === 401) {
    if (await refreshDeviceToken()) {
      res = await fetch(path, withAuth(getDeviceToken()))
    } else {
      await clearKioskDevice() // device revoked → back to login
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

// The server is authoritative, but rejecting guest writes here keeps every web
// mutation path consistent and avoids optimistic UI that can only roll back with
// a 403. Account/session maintenance stays available so a guest can switch away
// from the read-only household or accept access elsewhere.
export function guestRequestAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return true
  if (path === '/api/auth/switch' || path.startsWith('/api/account/')) return true
  return path.startsWith('/api/auth/invites/') && path.endsWith('/accept')
}

function assertMutationAllowed(method: string, path: string): void {
  if (viewerMemberType !== 'guest' || guestRequestAllowed(method, path)) return
  throw new ApiSendError(method, path, 403, {
    error: 'Forbidden',
    message: 'Guest access is read-only.',
  })
}

export async function apiSend<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  assertMutationAllowed(method, path)
  const res = await authFetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new ApiSendError(method, path, res.status, errBody)
  }
  return res.json() as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  assertMutationAllowed('DELETE', path)
  const res = await authFetch(path, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`)
}

// Local YYYY-MM-DD (kiosk timezone), used to match "tonight" and window the week.
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
