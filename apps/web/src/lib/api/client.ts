// Shared fetch helpers for the api client. In dev, Vite proxies /api to the api
// container; in the stack, Caddy does. Auth is a JWT session: a short-lived access
// token + a rotating refresh token in localStorage (set by the login/setup flow).
// A 401 transparently refreshes once and retries; a failed refresh clears the
// session and signals the AuthGate to show the login screen.
import {
  broadcastPrincipalTransitionFailed,
  broadcastPrincipalTransitionFinished,
  broadcastPrincipalTransitionStarted,
  freezeLocalWrites,
  originWideLockingAvailable,
  transitionPrincipal,
  withKioskDeviceLock,
  withPrincipalUseLock,
  withPrincipalTransitionLock,
  withSessionRefreshLock,
  waitForLocalWritesToDrain,
  type PrincipalTransitionPolicy,
  type PrincipalTransitionResult,
} from '../powersync/principal-transition'

const ACCESS_KEY = 'waffled.access'
const REFRESH_KEY = 'waffled.refresh'
const SESSION_SCOPE_KEY = 'waffled.sessionScope'
const SESSION_KEY = 'waffled.session.v1'
const VIEWER_MEMBER_TYPE_KEY = 'waffled.currentMemberType'
const VIEWER_MEMBER_TYPE_SCOPE_KEY = 'waffled.currentMemberTypeScope'
const VIEWER_ACCESS_KEY = 'waffled.currentViewerAccess.v1'
const BUILTIN_MEMBER_TYPES = new Set(['adult', 'caregiver', 'guest', 'teen', 'kid'])

// Short-lived GETs can contain household-private generated content. Keep the
// cache in the same identity boundary as the viewer metadata so a login,
// household switch, or kiosk profile switch can never reuse the prior
// principal's response.
const getCache = new Map<string, {
  identityScope: string | null
  at: number
  p: Promise<unknown>
}>()

// ── kiosk device layer ─────────────────────────────────────────────────────────
// A paired tablet stores a long-lived device secret (persists across profile
// switches and idle) and a short-lived device access token minted from it. The
// access/refresh keys above are reused for the *currently claimed profile* — an
// ephemeral session cleared on switch/idle while the device stays paired.
const DEVICE_SECRET_KEY = 'waffled.kiosk.deviceSecret'
const DEVICE_ID_KEY = 'waffled.kiosk.deviceId'
const DEVICE_ACCESS_KEY = 'waffled.kiosk.deviceAccess'
const DEVICE_GENERATION_KEY = 'waffled.kiosk.deviceGeneration'
const KIOSK_MODE_KEY = 'waffled.kiosk.mode'      // device is paired (→ profile picker)
const KIOSK_DEVICE_KEY = 'waffled.kiosk.device.v1'
const DISPLAY_MODE_KEY = 'waffled.kiosk.display' // this browser is the always-on display

interface PairedKioskDevice {
  v: 1
  state: 'paired'
  deviceId: string
  deviceSecret: string
  generation: string
}

interface UnpairedKioskDevice {
  v: 1
  state: 'unpaired'
}

type StoredKioskDevice = PairedKioskDevice | UnpairedKioskDevice

interface StoredSession {
  v: 1
  scope: string
  accessToken: string
  refreshToken: string
  // Authentication and its local authorization policy are one durable commit.
  // null memberType is reserved for internal/test callers which deliberately do
  // not have a server policy; production session responses always provide one.
  memberType: string | null
  accessExpiresAt: string | null
}

interface LegacyStoredSession {
  v: 1
  scope: string
  accessToken: string
  refreshToken: string
}

interface SignedOutSession {
  v: 1
  signedOut: true
}

interface SessionViewerAccess {
  memberType: string | null
  accessExpiresAt: string | null
}

interface ViewerAccessUpdateOptions {
  // `/api/household` is a live observation inside an existing session, not a new
  // authentication boundary. It may tighten cached authority, but an out-of-order
  // response must never promote a guest or extend an earlier deadline.
  preventAuthorityExtension?: boolean
}

const UNKNOWN_VIEWER_ACCESS: SessionViewerAccess = {
  memberType: null,
  accessExpiresAt: null,
}

function parseViewerAccessExpiry(value: unknown): {
  value: string | null
  milliseconds: number | null
} | null {
  if (value === null) return { value: null, milliseconds: null }
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  return { value: new Date(milliseconds).toISOString(), milliseconds }
}

function isTemporaryMemberType(memberType: string | null): boolean {
  return memberType === 'caregiver' || memberType === 'guest'
}

function normalizeSessionViewerAccess(
  input: { memberType?: string | null; accessExpiresAt?: string | null } | undefined,
  opts: { requirePolicy: boolean }
): SessionViewerAccess {
  if (!input) {
    if (opts.requirePolicy) throw new Error('The server returned an incomplete session policy.')
    return UNKNOWN_VIEWER_ACCESS
  }
  if (typeof input.memberType !== 'string' || !BUILTIN_MEMBER_TYPES.has(input.memberType)) {
    throw new Error('The server returned an invalid session role.')
  }
  const hasExpiry = Object.prototype.hasOwnProperty.call(input, 'accessExpiresAt')
  if (isTemporaryMemberType(input.memberType) && !hasExpiry) {
    throw new Error('The server omitted the temporary access deadline.')
  }
  // An explicit null is meaningful: caregivers and guests may intentionally have
  // indefinite access. Only omission/undefined or a malformed date is unknown.
  const rawExpiry = hasExpiry ? input.accessExpiresAt : null
  const expiry = parseViewerAccessExpiry(rawExpiry)
  if (!expiry) throw new Error('The server returned an invalid temporary access deadline.')
  return { memberType: input.memberType, accessExpiresAt: expiry.value }
}

function noMorePermissiveViewerAccess(
  current: StoredSession,
  requested: SessionViewerAccess
): SessionViewerAccess {
  // An unknown/test policy has no proven authority to preserve; the first valid
  // live observation may establish it. Production sessions start with a role.
  if (current.memberType === null) return requested

  // `guest` is the only wholly read-only built-in role. Other role transitions
  // have no total ordering client-side, so retain the already-committed role
  // unless the observation is the unambiguously stricter guest role.
  const memberType = requested.memberType === 'guest' ? 'guest' : current.memberType
  const currentExpiry = parseViewerAccessExpiry(current.accessExpiresAt)
  const requestedExpiry = parseViewerAccessExpiry(requested.accessExpiresAt)
  if (!currentExpiry || !requestedExpiry) {
    return { memberType, accessExpiresAt: new Date(0).toISOString() }
  }

  // null means indefinite. A live observation can introduce or shorten a finite
  // deadline, but cannot remove or lengthen the one already committed.
  let accessExpiresAt = currentExpiry.value
  if (currentExpiry.milliseconds === null) {
    accessExpiresAt = requestedExpiry.value
  } else if (requestedExpiry.milliseconds !== null &&
      requestedExpiry.milliseconds < currentExpiry.milliseconds) {
    accessExpiresAt = requestedExpiry.value
  }
  return { memberType, accessExpiresAt }
}

// undefined = no atomic record yet (legacy migration is allowed); null = a
// malformed atomic record (fail signed-out and never revive older split keys).
function parsedSessionRecord(): StoredSession | LegacyStoredSession | SignedOutSession | null | undefined {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw === null) return undefined
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.v !== 1) return null
    if (value.signedOut === true) return { v: 1, signedOut: true }
    if (typeof value.scope !== 'string' || !value.scope ||
        typeof value.accessToken !== 'string' || !value.accessToken ||
        typeof value.refreshToken !== 'string' || !value.refreshToken) return null
    const credentials: LegacyStoredSession = {
      v: 1,
      scope: value.scope,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
    }
    const hasMemberType = Object.prototype.hasOwnProperty.call(value, 'memberType')
    const hasExpiry = Object.prototype.hasOwnProperty.call(value, 'accessExpiresAt')
    if (!hasMemberType && !hasExpiry) return credentials
    if (!hasMemberType ||
        (value.memberType !== null &&
          (typeof value.memberType !== 'string' || !BUILTIN_MEMBER_TYPES.has(value.memberType)))) return null
    // Every new unknown/temporary policy has an explicit expiry field. A missing
    // field is tolerated only for a proven permanent role from an early rollout.
    if (!hasExpiry && (value.memberType === null || isTemporaryMemberType(value.memberType as string))) return null
    const expiry = parseViewerAccessExpiry(hasExpiry ? value.accessExpiresAt : null)
    if (!expiry) return null
    return {
      ...credentials,
      memberType: value.memberType as string | null,
      accessExpiresAt: expiry.value,
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

let pendingLegacySessionResolution: string | null = null

function sameLegacySession(
  current: ReturnType<typeof parsedSessionRecord>,
  expected: LegacyStoredSession
): current is LegacyStoredSession {
  return !!current && !('signedOut' in current) && !('memberType' in current) &&
    current.scope === expected.scope && current.accessToken === expected.accessToken &&
    current.refreshToken === expected.refreshToken
}

// A getter has to remain synchronous, but migration is a durable credential
// write. Return the safely scoped compatibility view immediately and persist it
// only while holding the same principal -> refresh lock order as every other
// whole-session rewrite. The exact-record check is the CAS: if a replacement
// session won while this request waited, the migration becomes a no-op.
function scheduleLegacySessionResolution(
  expected: LegacyStoredSession,
  migrated: StoredSession | null
): void {
  if (!originWideLockingAvailable()) return
  const key = JSON.stringify([expected, migrated])
  if (pendingLegacySessionResolution === key) return
  pendingLegacySessionResolution = key
  const attempt = withPrincipalUseLock(() => withSessionRefreshLock(async () => {
    const current = parsedSessionRecord()
    if (!sameLegacySession(current, expected)) return
    if (migrated) {
      // The separately stored policy is still part of the migration predicate;
      // an older tab changing it while the lock was queued must not be folded
      // into credentials under the policy we observed earlier.
      const access = readLegacyViewerAccess(current.scope)
      if (!access || access.memberType !== migrated.memberType ||
          access.accessExpiresAt !== migrated.accessExpiresAt) return
      localStorage.setItem(SESSION_KEY, JSON.stringify(migrated))
      removeLegacyViewerAccessStorage()
      return
    }
    storeSignedOutSession()
    removeLegacyViewerAccessStorage()
  }))
  void attempt.catch(() => {
    /* compatibility migration is best-effort; the legacy record stays fail-closed */
  }).finally(() => {
    if (pendingLegacySessionResolution === key) pendingLegacySessionResolution = null
  })
}

function legacySplitSessionSnapshot(): string | null {
  try {
    const values = [ACCESS_KEY, REFRESH_KEY, SESSION_SCOPE_KEY]
      .map((key) => localStorage.getItem(key))
    return values.some((value) => value !== null) ? JSON.stringify(values) : null
  } catch {
    return null
  }
}

function scheduleLegacySplitSessionTombstone(snapshot: string): void {
  if (!originWideLockingAvailable()) return
  const key = `split:${snapshot}`
  if (pendingLegacySessionResolution === key) return
  pendingLegacySessionResolution = key
  const attempt = withPrincipalUseLock(() => withSessionRefreshLock(async () => {
    if (parsedSessionRecord() !== undefined || legacySplitSessionSnapshot() !== snapshot) return
    storeSignedOutSession()
  }))
  void attempt.catch(() => {
    /* the split representation is never authenticated even when cleanup fails */
  }).finally(() => {
    if (pendingLegacySessionResolution === key) pendingLegacySessionResolution = null
  })
}

function resolvedSessionRecord(): StoredSession | SignedOutSession | null {
  const record = parsedSessionRecord()
  if (record !== undefined) {
    if (!record || 'signedOut' in record || 'memberType' in record) {
      return record ?? { v: 1, signedOut: true }
    }

    // Rolling upgrade from the first atomic-credential record. A separately
    // cached permanent role can safely be folded into the session. Temporary
    // roles (including explicit-indefinite caregiver/guest) are not safe to join
    // across two records: a crash/interleaved tab may have left the deadline from
    // another principal. Require one re-authentication instead.
    const legacyAccess = readLegacyViewerAccess(record.scope)
    if (legacyAccess && !isTemporaryMemberType(legacyAccess.memberType) &&
        legacyAccess.accessExpiresAt === null) {
      const migrated: StoredSession = {
        ...record,
        memberType: legacyAccess.memberType,
        accessExpiresAt: null,
      }
      if (!originWideLockingAvailable()) return null
      scheduleLegacySessionResolution(record, migrated)
      return migrated
    }
    scheduleLegacySessionResolution(record, null)
    return null
  }

  // The old representation wrote access/refresh/scope as three independent
  // localStorage operations. During a rolling upgrade, another tab (or a crash)
  // can leave tokens from different principals, and there is no client-side way
  // to validate that pair safely. Require one re-login instead of ever combining
  // those split values into the atomic record.
  const splitSnapshot = legacySplitSessionSnapshot()
  if (splitSnapshot) scheduleLegacySplitSessionTombstone(splitSnapshot)
  return null
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

// localStorage is shared immediately across same-origin tabs, while the storage
// event which gates and remounts this tab arrives asynchronously. Remember the
// identity generation this document has actually accepted so a remote A -> B
// commit cannot make still-mounted A controls dispatch with B's credentials in
// that gap. Local credential commits advance this fence synchronously.
let documentAcceptedIdentityScope = authSessionSnapshot().identityScope

function documentAcceptsIdentityScope(identityScope: string | null): boolean {
  return documentAcceptedIdentityScope === identityScope
}

// AuthGate is the only production caller. It invokes this from a layout effect
// after a replacement principal has caused the old React tree to be removed from
// the committed DOM. Until that acknowledgement, localStorage may expose the new
// credentials to this module but every authenticated request remains closed.
export function acknowledgeCurrentIdentityScopeAfterGate(
  expectedIdentityScope: string | null
): boolean {
  if (authSessionSnapshot().identityScope !== expectedIdentityScope) return false
  if (documentAcceptsIdentityScope(expectedIdentityScope)) return true

  // Drop all document-local identity state from the principal which was just
  // gated. Re-read the durable generation before advancing the fence in case a
  // second same-origin replacement landed during this synchronous cleanup.
  clearCurrentViewerIdentity()
  if (authSessionSnapshot().identityScope !== expectedIdentityScope) return false
  documentAcceptedIdentityScope = expectedIdentityScope
  syncCurrentViewerAccess(expectedIdentityScope)
  return true
}

function storeSession(
  accessToken: string,
  refreshToken: string,
  scope = freshSessionScope(),
  viewerAccess: SessionViewerAccess = UNKNOWN_VIEWER_ACCESS
): StoredSession {
  const record: StoredSession = { v: 1, scope, accessToken, refreshToken, ...viewerAccess }
  // One synchronous set is the credential + authorization-policy commit point: a
  // crash cannot combine one principal's tokens with another role/deadline.
  localStorage.setItem(SESSION_KEY, JSON.stringify(record))
  documentAcceptedIdentityScope = `session:${scope}`
  removeLegacySessionKeys()
  removeLegacyViewerAccessStorage()
  return record
}

function storeSignedOutSession(): void {
  // Keep a tombstone instead of merely removing the record. If cleanup is
  // interrupted, stale legacy keys cannot be migrated back into a live session.
  localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 1, signedOut: true } satisfies SignedOutSession))
  documentAcceptedIdentityScope = null
  removeLegacySessionKeys()
}

export function isKioskMode(): boolean {
  return currentKioskDeviceLease() !== null
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
  return currentKioskDeviceLease()?.deviceId
}

export interface KioskDeviceLease {
  deviceId: string
  deviceSecret: string
  generation: string
}

function removeLegacyKioskDeviceKeys(): void {
  for (const key of [DEVICE_SECRET_KEY, DEVICE_ID_KEY, DEVICE_GENERATION_KEY, KIOSK_MODE_KEY]) {
    try { localStorage.removeItem(key) } catch { /* best effort after atomic commit */ }
  }
}

// undefined = no atomic record yet (legacy migration is allowed); null = a
// malformed atomic record (fail unpaired and never revive split legacy state).
function parsedKioskDeviceRecord(): StoredKioskDevice | null | undefined {
  try {
    const raw = localStorage.getItem(KIOSK_DEVICE_KEY)
    if (raw === null) return undefined
    const value = JSON.parse(raw) as {
      v?: unknown
      state?: unknown
      deviceId?: unknown
      deviceSecret?: unknown
      generation?: unknown
    }
    if (value.v !== 1) return null
    if (value.state === 'unpaired') return { v: 1, state: 'unpaired' }
    if (value.state !== 'paired' || typeof value.deviceId !== 'string' || !value.deviceId ||
        typeof value.deviceSecret !== 'string' || !value.deviceSecret ||
        typeof value.generation !== 'string' || !value.generation) return null
    return {
      v: 1,
      state: 'paired',
      deviceId: value.deviceId,
      deviceSecret: value.deviceSecret,
      generation: value.generation,
    }
  } catch {
    return null
  }
}

function storeUnpairedKioskDevice(): void {
  localStorage.setItem(KIOSK_DEVICE_KEY, JSON.stringify({
    v: 1,
    state: 'unpaired',
  } satisfies UnpairedKioskDevice))
  removeLegacyKioskDeviceKeys()
}

interface LegacyKioskDeviceSnapshot {
  deviceId: string | null
  deviceSecret: string | null
  generation: string | null
  kioskMode: string | null
}

let pendingLegacyKioskResolution: string | null = null
let ephemeralLegacyKioskGeneration: { key: string; value: string } | null = null

function legacyKioskDeviceSnapshot(): LegacyKioskDeviceSnapshot | null {
  try {
    return {
      deviceId: localStorage.getItem(DEVICE_ID_KEY),
      deviceSecret: localStorage.getItem(DEVICE_SECRET_KEY),
      generation: localStorage.getItem(DEVICE_GENERATION_KEY),
      kioskMode: localStorage.getItem(KIOSK_MODE_KEY),
    }
  } catch {
    return null
  }
}

function sameLegacyKioskSnapshot(
  a: LegacyKioskDeviceSnapshot | null,
  b: LegacyKioskDeviceSnapshot
): boolean {
  return !!a && a.deviceId === b.deviceId && a.deviceSecret === b.deviceSecret &&
    a.generation === b.generation && a.kioskMode === b.kioskMode
}

function legacyKioskGeneration(snapshot: LegacyKioskDeviceSnapshot): string {
  if (snapshot.generation) return snapshot.generation
  const key = JSON.stringify(snapshot)
  if (ephemeralLegacyKioskGeneration?.key !== key) {
    ephemeralLegacyKioskGeneration = { key, value: freshSessionScope() }
  }
  return ephemeralLegacyKioskGeneration.value
}

// Pairing state is another durable principal boundary. Publish a compatibility
// tuple only beneath the kiosk-device lease, and treat the complete split-key
// snapshot as the CAS predicate so a newer pair/unpair always wins.
function scheduleLegacyKioskResolution(
  snapshot: LegacyKioskDeviceSnapshot,
  migrated: PairedKioskDevice | null
): void {
  if (!originWideLockingAvailable()) return
  const key = JSON.stringify([snapshot, migrated])
  if (pendingLegacyKioskResolution === key) return
  pendingLegacyKioskResolution = key
  const attempt = withKioskDeviceLock(async () => {
    if (parsedKioskDeviceRecord() !== undefined ||
        !sameLegacyKioskSnapshot(legacyKioskDeviceSnapshot(), snapshot)) return
    if (migrated) {
      localStorage.setItem(KIOSK_DEVICE_KEY, JSON.stringify(migrated))
      removeLegacyKioskDeviceKeys()
    } else {
      storeUnpairedKioskDevice()
    }
  })
  void attempt.catch(() => {
    /* compatibility migration remains fail-closed if it cannot obtain the lease */
  }).finally(() => {
    if (pendingLegacyKioskResolution === key) pendingLegacyKioskResolution = null
  })
}

function resolvedKioskDeviceRecord(): PairedKioskDevice | null {
  const parsed = parsedKioskDeviceRecord()
  if (parsed !== undefined) {
    if (parsed?.state === 'paired') return parsed
    return null
  }

  // The synchronous compatibility view is safe only when its eventual durable
  // commit can be serialized origin-wide. Without Web Locks, split device state
  // remains untrusted and the kiosk stays unpaired.
  const snapshot = legacyKioskDeviceSnapshot()
  if (!snapshot || !originWideLockingAvailable()) return null
  if (snapshot.kioskMode === '1' && snapshot.deviceId && snapshot.deviceSecret) {
    const migrated: PairedKioskDevice = {
      v: 1,
      state: 'paired',
      deviceId: snapshot.deviceId,
      deviceSecret: snapshot.deviceSecret,
      generation: legacyKioskGeneration(snapshot),
    }
    scheduleLegacyKioskResolution(snapshot, migrated)
    return migrated
  }
  scheduleLegacyKioskResolution(snapshot, null)
  return null
}

export function currentKioskDeviceLease(): KioskDeviceLease | null {
  const record = resolvedKioskDeviceRecord()
  return record ? {
    deviceId: record.deviceId,
    deviceSecret: record.deviceSecret,
    generation: record.generation,
  } : null
}

export function isCurrentKioskDeviceLease(lease: KioskDeviceLease): boolean {
  const current = currentKioskDeviceLease()
  return !!current && current.deviceId === lease.deviceId &&
    current.deviceSecret === lease.deviceSecret && current.generation === lease.generation
}

function getDeviceToken(lease: KioskDeviceLease | null = currentKioskDeviceLease()): string | undefined {
  if (!lease) return undefined
  try {
    const raw = localStorage.getItem(DEVICE_ACCESS_KEY)
    if (!raw) return undefined
    try {
      const record = JSON.parse(raw) as { v?: unknown; generation?: unknown; token?: unknown }
      return record.v === 1 && record.generation === lease.generation &&
        typeof record.token === 'string' && record.token ? record.token : undefined
    } catch {
      // The legacy value has no device id or generation. During a cross-tab or
      // interrupted migration it may be A's bearer beside B's device tuple, so it
      // is impossible to bind safely. Drop it and exchange B's atomic secret for
      // a freshly scoped token on the first request.
      localStorage.removeItem(DEVICE_ACCESS_KEY)
      return undefined
    }
  } catch {
    return undefined
  }
}
// Store the paired device (secret + id + kiosk-mode flag) WITHOUT navigating, so the
// pairing screen can run its post-pair "name this kiosk" step first. The device token
// works immediately (the secret is stored). Call enterKioskMode() to actually proceed.
export function commitKioskDeviceUnderLocks(
  deviceSecret: string,
  deviceId: string,
  opts: {
    expectedLease?: KioskDeviceLease | null
    expectedIdentityScope?: string | null
  } = {}
): void {
  // This is the non-relocking commit seam used when pair/promote already retain
  // the kiosk -> principal leases across their server-side device creation.
  if (Object.prototype.hasOwnProperty.call(opts, 'expectedIdentityScope') &&
      currentIdentityScope() !== opts.expectedIdentityScope) {
    throw new Error('The active account changed while pairing.')
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'expectedLease')) {
    const stillCurrent = opts.expectedLease
      ? isCurrentKioskDeviceLease(opts.expectedLease)
      : currentKioskDeviceLease() === null
    if (!stillCurrent) throw new Error('The kiosk device changed while pairing.')
  }
  const record: PairedKioskDevice = {
    v: 1,
    state: 'paired',
    deviceSecret,
    deviceId,
    generation: freshSessionScope(),
  }
  try {
    // The tuple is the commit point. Once this succeeds, pairing succeeded;
    // cleanup below is generation-scoped and cannot invalidate that result.
    localStorage.setItem(KIOSK_DEVICE_KEY, JSON.stringify(record))
  } catch (error) {
    // Leave the previously committed whole record intact and do not let the UI
    // proceed as though pairing succeeded.
    throw new Error('Could not safely save this kiosk device.', { cause: error })
  }
  // A stale device bearer is unusable because it embeds the prior generation.
  // Treat cleanup as best-effort so a removeItem failure cannot turn an already
  // committed pair into a reported failure.
  try { localStorage.removeItem(DEVICE_ACCESS_KEY) } catch { /* generation fence wins */ }
  removeLegacyKioskDeviceKeys()
}

export async function setKioskDevice(
  deviceSecret: string,
  deviceId: string,
  opts: {
    expectedLease?: KioskDeviceLease | null
    expectedIdentityScope?: string | null
  } = {}
): Promise<void> {
  // Device replacement and session replacement use independent origin locks.
  // Take them in the same kiosk -> principal order as claim/unpair, and retain
  // both leases through the atomic record write.
  await withKioskDeviceLock(() => withPrincipalUseLock(async () => {
    commitKioskDeviceUnderLocks(deviceSecret, deviceId, opts)
  }))
}
// Re-resolve the AuthGate now that the device is paired → the profile picker (or, if
// an admin is still signed in on this browser, just refreshes their session chrome).
export function enterKioskMode(): void {
  window.dispatchEvent(new Event('waffled:auth-changed'))
}
// Unpair entirely (admin revoked the device, or the operator un-kiosks it): drop
// the device + any profile session → back to the normal login screen.
export async function clearKioskDevice(
  expectedLease: KioskDeviceLease | null = currentKioskDeviceLease()
): Promise<void> {
  const identityScope = currentIdentityScope()
  await withKioskDeviceLock(async () => {
    await changePrincipal(
      'discard-authorized',
      'signed-out',
      () => {
        clearCurrentViewerIdentity()
        storeSignedOutSession()
        // The durable device tombstone is the unpair commit point. If storage is
        // unavailable, surface failure and leave the paired record available for
        // an explicit retry; never tell the UI that a long-lived secret was erased.
        storeUnpairedKioskDevice()
        // The tombstone is authoritative. Any surviving bearer is unusable
        // without a current device generation (and the signed-out session
        // tombstone suppresses the development bearer), so cleanup must not turn
        // an already committed unpair into a reported transition failure.
        try { localStorage.removeItem(DEVICE_ACCESS_KEY) } catch { /* tombstone wins */ }
        try { localStorage.removeItem('waffled.token') } catch { /* session tombstone wins */ }
      },
      {
        identityScope,
        // Pairing a replacement device while unpair cleanup waits must win. The
        // old revocation path is not authorized to erase the new generation.
        stillCurrent: () => expectedLease
          ? isCurrentKioskDeviceLease(expectedLease)
          : currentKioskDeviceLease() === null,
      }
    )
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

interface StoredViewerAccess {
  v: 1
  scope: string
  memberType: string
  accessExpiresAt: string | null
}

interface ViewerAccessState {
  scope: string | null
  memberType: string | null
  accessExpiresAt: string | null
  accessExpiresAtMs: number | null
}

function removeLegacyViewerAccessStorage(): void {
  try {
    localStorage.removeItem(VIEWER_ACCESS_KEY)
    localStorage.removeItem(VIEWER_MEMBER_TYPE_KEY)
    localStorage.removeItem(VIEWER_MEMBER_TYPE_SCOPE_KEY)
  } catch {
    /* best effort after the atomic record is committed */
  }
}

function readLegacyViewerAccess(sessionScope: string): ViewerAccessState | null {
  const identityScope = `session:${sessionScope}`
  const scoped = readExternalViewerAccess(identityScope)
  if (scoped) return scoped
  try {
    // The oldest two-key cache proves only the role. That is enough for a
    // permanent role; a temporary role is returned as expired so the caller can
    // identify it and refuse to splice it into the credential record.
    const legacyMemberType = localStorage.getItem(VIEWER_MEMBER_TYPE_KEY)
    const legacyScope = localStorage.getItem(VIEWER_MEMBER_TYPE_SCOPE_KEY)
    if (legacyScope === identityScope && legacyMemberType && BUILTIN_MEMBER_TYPES.has(legacyMemberType)) {
      const accessExpiresAt = isTemporaryMemberType(legacyMemberType)
        ? new Date(0).toISOString()
        : null
      return {
        scope: identityScope,
        memberType: legacyMemberType,
        accessExpiresAt,
        accessExpiresAtMs: accessExpiresAt ? 0 : null,
      }
    }
  } catch {
    /* localStorage unavailable */
  }
  return null
}

function readExternalViewerAccess(scope: string): ViewerAccessState | null {
  try {
    const raw = localStorage.getItem(VIEWER_ACCESS_KEY)
    if (!raw) return null
    const record = JSON.parse(raw) as Partial<StoredViewerAccess>
    const expiry = parseViewerAccessExpiry(record.accessExpiresAt)
    if (record.v !== 1 || record.scope !== scope ||
        typeof record.memberType !== 'string' || !BUILTIN_MEMBER_TYPES.has(record.memberType) || !expiry) {
      return null
    }
    return {
      scope,
      memberType: record.memberType,
      accessExpiresAt: expiry.value,
      accessExpiresAtMs: expiry.milliseconds,
    }
  } catch {
    return null
  }
}

function readCurrentViewerAccess(scope: string | null): ViewerAccessState | null {
  if (!scope) return null
  if (!scope.startsWith('session:')) return readExternalViewerAccess(scope)
  const session = resolvedSessionRecord()
  if (!session || 'signedOut' in session || scope !== `session:${session.scope}`) return null
  const expiry = parseViewerAccessExpiry(session.accessExpiresAt)
  if (!expiry) return null // parsed sessions guarantee this; remain fail-closed if that changes
  return {
    scope,
    memberType: session.memberType,
    accessExpiresAt: expiry.value,
    accessExpiresAtMs: expiry.milliseconds,
  }
}

const initialViewerAccess = readCurrentViewerAccess(currentIdentityScope())
let viewerAccessScope: string | null = initialViewerAccess?.scope ?? null
let viewerMemberType: string | null = initialViewerAccess?.memberType ?? null
let viewerAccessExpiresAtMs: number | null = initialViewerAccess?.accessExpiresAtMs ?? null
let viewerAccessExpiryTimer: ReturnType<typeof setTimeout> | null = null
let viewerAccessUpdateRevision = 0
let viewerAccessUpdatePendingScope: string | null = null
let viewerAccessBlockedScope: string | null = null

function syncCurrentViewerAccess(scope: string | null): void {
  // Keep explicit in-memory test/dev roles working when there is no durable
  // session. Authenticated state is always re-read from the atomic scoped record
  // so a replacement committed by another tab cannot inherit this tab's role or
  // deadline.
  if (!scope) {
    if (viewerAccessScope) {
      viewerAccessScope = null
      viewerMemberType = null
      viewerAccessExpiresAtMs = null
    }
    viewerAccessUpdatePendingScope = null
    viewerAccessBlockedScope = null
    return
  }
  if (viewerAccessUpdatePendingScope && viewerAccessUpdatePendingScope !== scope) {
    viewerAccessUpdatePendingScope = null
  }
  if (viewerAccessBlockedScope && viewerAccessBlockedScope !== scope) {
    viewerAccessBlockedScope = null
  }
  // Keep the conservative in-memory policy while a durable update is pending,
  // and never let an older on-disk policy reopen a session whose update failed.
  if (viewerAccessUpdatePendingScope === scope || viewerAccessBlockedScope === scope) return
  const stored = readCurrentViewerAccess(scope)
  viewerAccessScope = stored?.scope ?? null
  viewerMemberType = stored?.memberType ?? null
  viewerAccessExpiresAtMs = stored?.accessExpiresAtMs ?? null
}

function currentViewerAccessExpiredForScope(scope: string | null, now = Date.now()): boolean {
  if (scope && viewerAccessBlockedScope === scope) return true
  syncCurrentViewerAccess(scope)
  return viewerAccessScope === scope && viewerAccessExpiresAtMs !== null && viewerAccessExpiresAtMs <= now
}

export function currentViewerPersonId(): string | null {
  return viewerPersonId
}
export function setCurrentViewerPersonId(id: string | null): void {
  viewerPersonId = id
}
export function setCurrentViewerMemberType(memberType: string | null): void {
  void setCurrentViewerAccess(memberType, null).catch(() => {})
}
export async function setCurrentViewerAccess(
  memberType: string | null,
  accessExpiresAt: string | null | undefined,
  opts: ViewerAccessUpdateOptions = {}
): Promise<void> {
  const trusted = memberType && BUILTIN_MEMBER_TYPES.has(memberType) ? memberType : null
  const deadlineMissing = trusted && isTemporaryMemberType(trusted) && accessExpiresAt === undefined
  const parsedExpiry = deadlineMissing ? null : parseViewerAccessExpiry(accessExpiresAt ?? null)
  const expiry = parsedExpiry ?? { value: new Date(0).toISOString(), milliseconds: 0 }
  const requestedAccess: SessionViewerAccess = {
    memberType: trusted,
    accessExpiresAt: expiry.value,
  }
  const sessionSnapshot = authSessionSnapshot()
  const scope = sessionSnapshot.identityScope

  if (!scope?.startsWith('session:')) {
    viewerAccessScope = trusted ? scope : null
    viewerMemberType = trusted
    viewerAccessExpiresAtMs = trusted ? expiry.milliseconds : null
    try {
      if (trusted && scope) {
        // Development bearer sessions have no atomic refresh-token record;
        // their scoped cache cannot influence real StoredSessions.
        localStorage.setItem(VIEWER_ACCESS_KEY, JSON.stringify({
          v: 1,
          scope,
          memberType: trusted,
          accessExpiresAt: expiry.value,
        } satisfies StoredViewerAccess))
        localStorage.removeItem(VIEWER_MEMBER_TYPE_KEY)
        localStorage.removeItem(VIEWER_MEMBER_TYPE_SCOPE_KEY)
      } else {
        removeLegacyViewerAccessStorage()
      }
      documentAcceptedIdentityScope = scope
    } catch {
      viewerAccessScope = null
      viewerMemberType = null
      viewerAccessExpiresAtMs = null
    }
    armViewerAccessExpiry(scope)
    return
  }

  const session = resolvedSessionRecord()
  if (!session || 'signedOut' in session || scope !== `session:${session.scope}`) return

  // A missing/unknown role, omitted temporary deadline, or malformed deadline
  // is not a usable authorization policy for an authenticated session.
  if (!trusted || !parsedExpiry) {
    viewerAccessBlockedScope = scope
    viewerAccessUpdatePendingScope = null
    viewerAccessScope = scope
    viewerMemberType = trusted
    viewerAccessExpiresAtMs = 0
    scheduleEndLostSession(scope, sessionSnapshot.refreshToken, 'policy-invalid')
    window.dispatchEvent(new Event('waffled:auth-changed'))
    throw new Error('The server returned an invalid household access policy.')
  }

  const initialAccess = opts.preventAuthorityExtension
    ? noMorePermissiveViewerAccess(session, requestedAccess)
    : requestedAccess
  const initialExpiry = parseViewerAccessExpiry(initialAccess.accessExpiresAt)
  viewerAccessScope = scope
  viewerMemberType = initialAccess.memberType
  viewerAccessExpiresAtMs = initialExpiry ? initialExpiry.milliseconds : 0

  const revision = ++viewerAccessUpdateRevision
  if (session.memberType === initialAccess.memberType &&
      session.accessExpiresAt === initialAccess.accessExpiresAt) {
    viewerAccessUpdatePendingScope = null
    viewerAccessBlockedScope = null
    armViewerAccessExpiry(scope)
    return
  }

  // A live policy response may demote this principal to read-only. Freeze local
  // admission immediately, drain writers which were already admitted, then hold
  // the origin-wide exclusive principal lease through the durable policy commit.
  // That prevents a write from entering SQLite under the old role after the new
  // policy has been observed. The refresh lock remains second in the global order.
  viewerAccessUpdatePendingScope = scope
  armViewerAccessExpiry(scope)
  let cleanupRefreshToken = sessionSnapshot.refreshToken
  const unfreezeLocalWrites = freezeLocalWrites()
  try {
    await waitForLocalWritesToDrain()
    const updated = await withPrincipalTransitionLock(() =>
      withSessionRefreshLock(async () => {
        if (revision !== viewerAccessUpdateRevision || currentIdentityScope() !== scope) return null
        const current = resolvedSessionRecord()
        if (!current || 'signedOut' in current || `session:${current.scope}` !== scope) return null
        cleanupRefreshToken = current.refreshToken
        const nextAccess = opts.preventAuthorityExtension
          ? noMorePermissiveViewerAccess(current, requestedAccess)
          : requestedAccess
        const next: StoredSession = {
          ...current,
          ...nextAccess,
        }
        localStorage.setItem(SESSION_KEY, JSON.stringify(next))
        removeLegacyViewerAccessStorage()
        return next
      })
    )
    if (revision !== viewerAccessUpdateRevision) return
    viewerAccessUpdatePendingScope = null
    if (!updated || currentIdentityScope() !== scope) {
      syncCurrentViewerAccess(currentIdentityScope())
      return
    }
    viewerAccessBlockedScope = null
    applyStoredViewerAccess(updated, { clearPolicyBlock: true })
  } catch (error) {
    if (revision !== viewerAccessUpdateRevision || currentIdentityScope() !== scope) return
    viewerAccessUpdatePendingScope = null
    viewerAccessBlockedScope = scope
    viewerAccessScope = scope
    viewerMemberType = trusted
    viewerAccessExpiresAtMs = 0
    // Do not write a tombstone here: doing so before capturing the old token
    // makes cleanup look stale and skips the private replica purge. Route the
    // captured scope/token through the serialized terminal transition instead.
    scheduleEndLostSession(scope, cleanupRefreshToken, 'policy-invalid')
    window.dispatchEvent(new Event('waffled:auth-changed'))
    throw error
  } finally {
    unfreezeLocalWrites()
  }
}

function clearCurrentViewerIdentity(): void {
  setCurrentViewerPersonId(null)
  viewerAccessScope = null
  viewerMemberType = null
  viewerAccessExpiresAtMs = null
  viewerAccessUpdateRevision++
  viewerAccessUpdatePendingScope = null
  viewerAccessBlockedScope = null
  if (viewerAccessExpiryTimer !== null) {
    clearTimeout(viewerAccessExpiryTimer)
    viewerAccessExpiryTimer = null
  }
  removeLegacyViewerAccessStorage()
  getCache.clear()
}

function applyStoredViewerAccess(
  record: StoredSession,
  opts: { clearPolicyBlock?: boolean } = {}
): void {
  const scope = `session:${record.scope}`
  // Refresh only rotates credentials. If a policy update is concurrently
  // waiting to merge into that rotation, keep its stricter in-memory policy
  // instead of briefly restoring the older role/deadline from disk. A blocked
  // policy likewise stays blocked while terminal cleanup rebinds to r2.
  if (!opts.clearPolicyBlock &&
      (viewerAccessUpdatePendingScope === scope || viewerAccessBlockedScope === scope)) {
    armViewerAccessExpiry(scope)
    return
  }
  if (opts.clearPolicyBlock && viewerAccessBlockedScope === scope) {
    viewerAccessBlockedScope = null
  }
  const expiry = parseViewerAccessExpiry(record.accessExpiresAt)
  viewerAccessScope = scope
  viewerMemberType = record.memberType
  viewerAccessExpiresAtMs = expiry ? expiry.milliseconds : 0
  armViewerAccessExpiry(scope)
}

// Local PowerSync writes must fail closed until /api/household has identified a
// built-in role. Otherwise a guest (or a stale/custom role the clients do not
// understand) can optimistically mutate SQLite and leave a rejected write at the
// head of the durable upload queue.
export function powerSyncMutationAllowed(memberType?: string | null): boolean {
  const session = authSessionSnapshot()
  if (!documentAcceptsIdentityScope(session.identityScope)) return false
  if (session.identityScope && viewerAccessUpdatePendingScope === session.identityScope) return false
  if (currentViewerAccessExpiredForScope(session.identityScope)) {
    scheduleEndLostSession(session.identityScope, session.refreshToken, 'access-expired')
    return false
  }
  const effectiveMemberType = memberType === undefined ? viewerMemberType : memberType
  return effectiveMemberType === 'adult' || effectiveMemberType === 'caregiver' ||
    effectiveMemberType === 'teen' || effectiveMemberType === 'kid'
}

export function getAccessToken(): string | undefined {
  const session = authSessionSnapshot()
  if (!documentAcceptsIdentityScope(session.identityScope)) return undefined
  if (currentViewerAccessExpiredForScope(session.identityScope)) {
    scheduleEndLostSession(session.identityScope, session.refreshToken, 'access-expired')
    return undefined
  }
  armViewerAccessExpiry(session.identityScope)
  return session.accessToken
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
    if (isolationBegan && broadcastId) {
      broadcastPrincipalTransitionFailed(broadcastId)
      broadcastId = null
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
  opts: {
    discardPending?: boolean
    expectedIdentityScope?: string | null
    stillCurrent?: () => boolean
    viewerAccess?: { memberType: string | null; accessExpiresAt?: string | null }
  } = {}
): Promise<void> {
  const suppliedPolicy = Object.prototype.hasOwnProperty.call(opts, 'viewerAccess')
  const viewerAccess = normalizeSessionViewerAccess(opts.viewerAccess, {
    // Production callers deliberately pass this property. Undefined means the
    // server omitted policy, not "permanent".
    requirePolicy: suppliedPolicy,
  })
  const replacementScope = freshSessionScope()
  const identityScope = Object.prototype.hasOwnProperty.call(opts, 'expectedIdentityScope')
    ? opts.expectedIdentityScope ?? null
    : currentIdentityScope()
  // With no current principal, any leftover replica is stale and its writes no
  // longer have credentials capable of uploading. An authenticated replacement
  // must instead preserve queued work unless the caller explicitly confirms loss.
  const policy: PrincipalTransitionPolicy = identityScope && !opts.discardPending
    ? 'require-no-pending'
    : 'discard-authorized'
  await changePrincipal(
    policy,
    'new-principal',
    () => {
      clearCurrentViewerIdentity()
      const record = storeSession(accessToken, refreshToken, replacementScope, viewerAccess)
      applyStoredViewerAccess(record)
      try { localStorage.removeItem('waffled.token') } catch { /* record wins */ }
    },
    { identityScope, stillCurrent: opts.stillCurrent }
  )
}

export async function setSessionFrom(
  prepare: () => Promise<{
    accessToken: string
    refreshToken: string
    memberType?: string | null
    accessExpiresAt?: string | null
  }>,
  opts: { discardPending?: boolean } = {}
): Promise<void> {
  const identityScope = currentIdentityScope()
  const policy: PrincipalTransitionPolicy = identityScope && !opts.discardPending
    ? 'require-no-pending'
    : 'discard-authorized'
  let replacement: {
    accessToken: string
    refreshToken: string
    memberType?: string | null
    accessExpiresAt?: string | null
  } | null = null
  let replacementAccess: SessionViewerAccess | null = null
  let replacementScope: string | null = null
  await changePrincipal(
    policy,
    'new-principal',
    () => {
      if (!replacement || !replacementAccess || !replacementScope) {
        throw new Error('Replacement credentials were not prepared')
      }
      clearCurrentViewerIdentity()
      const record = storeSession(
        replacement.accessToken,
        replacement.refreshToken,
        replacementScope,
        replacementAccess
      )
      applyStoredViewerAccess(record)
      try { localStorage.removeItem('waffled.token') } catch { /* record wins */ }
    },
    {
      identityScope,
      prepareReplacement: async () => {
        const prepared = await prepare()
        replacementAccess = normalizeSessionViewerAccess(prepared, { requirePolicy: true })
        replacementScope = freshSessionScope()
        replacement = prepared
      },
    }
  )
}
async function clearSessionWithCapture(
  opts: { discardPending?: boolean },
  captureRefreshToken?: (refreshToken: string | undefined) => void
): Promise<void> {
  await changePrincipal(
    opts.discardPending ? 'discard-authorized' : 'require-no-pending',
    'signed-out',
    () => {
      // The real coordinator invokes this while holding the origin refresh lock.
      // Capture the token at the same instant as the tombstone so logout revokes
      // a rotation which completed while the transition was waiting, not its
      // already-spent predecessor.
      captureRefreshToken?.(getRefreshToken())
      clearCurrentViewerIdentity()
      storeSignedOutSession()
      try { localStorage.removeItem('waffled.token') } catch { /* tombstone wins */ }
    }
  )
}

export async function clearSession(opts: { discardPending?: boolean } = {}): Promise<void> {
  await clearSessionWithCapture(opts)
}

export async function clearSessionForLogout(
  opts: { discardPending?: boolean } = {}
): Promise<string | undefined> {
  let refreshToken: string | undefined
  await clearSessionWithCapture(opts, (current) => { refreshToken = current })
  return refreshToken
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
  // In plain-LAN HTTP contexts Web Locks are unavailable and PowerSync is kept
  // REST-only. Never rotate a single-use token without origin-wide exclusion;
  // expire this generation instead so another tab cannot resurrect it after a
  // concurrent logout.
  if (!originWideLockingAvailable()) return Promise.resolve('invalid')
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
        const current = resolvedSessionRecord()
        if (!current || 'signedOut' in current || `session:${current.scope}` !== identityScope) {
          return 'stale' as const
        }
        const rotated = storeSession(
          d.accessToken,
          d.refreshToken,
          current.scope,
          { memberType: current.memberType, accessExpiresAt: current.accessExpiresAt }
        )
        applyStoredViewerAccess(rotated)
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
  reason: 'session-invalid' | 'access-expired' | 'policy-invalid'
  promise: Promise<void>
} | null = null

function scheduleEndLostSession(
  identityScope: string | null,
  refreshToken: string | undefined,
  reason: 'session-invalid' | 'access-expired' | 'policy-invalid' = 'session-invalid'
): void {
  if (endingLostSession?.identityScope === identityScope &&
      endingLostSession.refreshToken === refreshToken &&
      endingLostSession.reason === reason) return
  let attempt: Promise<void>
  attempt = Promise.resolve()
    .then(() => endLostSession(identityScope, refreshToken))
    .catch((error) => {
      // A newer login or successful refresh won the race; that is the desired
      // outcome, not a transition failure. Anything else must stay fail-closed
      // and visible through AuthGate.
      if (error instanceof PrincipalTransitionError && error.result === 'stale') {
        // A successful refresh preserves the identity scope but rotates the token.
        // That makes an expiry cleanup captured with r1 stale. Expiry itself did
        // not become stale, so rebind to r2 and finish the purge without waiting
        // for another user/API action. Ordinary 401 cleanup intentionally does
        // not retry: the successful rotation superseded that old response.
        if (reason === 'access-expired' || reason === 'policy-invalid') {
          const current = authSessionSnapshot()
          if (current.identityScope === identityScope &&
              current.refreshToken !== refreshToken &&
              currentViewerAccessExpiredForScope(identityScope)) {
            scheduleEndLostSession(identityScope, current.refreshToken, reason)
          }
        }
        return
      }
      window.dispatchEvent(new Event('waffled:principal-transition-failed'))
    })
    .finally(() => {
      if (endingLostSession?.promise === attempt) endingLostSession = null
    })
  endingLostSession = { identityScope, refreshToken, reason, promise: attempt }
}

const MAX_EXPIRY_TIMER_MS = 2_147_000_000

function armViewerAccessExpiry(identityScope: string | null): void {
  if (viewerAccessExpiryTimer !== null) {
    clearTimeout(viewerAccessExpiryTimer)
    viewerAccessExpiryTimer = null
  }
  syncCurrentViewerAccess(identityScope)
  if (!identityScope || viewerAccessScope !== identityScope || viewerAccessExpiresAtMs === null) return
  const remaining = viewerAccessExpiresAtMs - Date.now()
  if (remaining <= 0) {
    const session = authSessionSnapshot()
    if (session.identityScope === identityScope) {
      scheduleEndLostSession(identityScope, session.refreshToken, 'access-expired')
    }
    return
  }
  viewerAccessExpiryTimer = setTimeout(() => {
    viewerAccessExpiryTimer = null
    const session = authSessionSnapshot()
    if (session.identityScope !== identityScope) return
    if (currentViewerAccessExpiredForScope(identityScope)) {
      // Expiry is authorization loss. The same exclusive transition used for a
      // server-declared inactive membership hides the app, disconnects sync, and
      // purges its private replica even when this browser is offline.
      scheduleEndLostSession(identityScope, session.refreshToken, 'access-expired')
    } else {
      armViewerAccessExpiry(identityScope)
    }
  }, Math.min(remaining, MAX_EXPIRY_TIMER_MS))
}

// fetch with the bearer token + one transparent refresh-and-retry on 401.
async function authFetch(
  path: string,
  init: RequestInit,
  expectation?: { identityScope: string | null }
): Promise<Response> {
  const withAuth = (tok?: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  const initialSession = authSessionSnapshot()
  const identityScope = initialSession.identityScope
  let refreshToken = initialSession.refreshToken
  if (!documentAcceptsIdentityScope(identityScope)) {
    throw new Error(`Principal changed before ${path} could be sent`)
  }
  if (expectation && identityScope !== expectation.identityScope) {
    throw new Error(`Principal changed before ${path} could be sent`)
  }
  if (currentViewerAccessExpiredForScope(identityScope)) {
    scheduleEndLostSession(identityScope, refreshToken, 'access-expired')
    throw new Error('Household access has expired.')
  }
  armViewerAccessExpiry(identityScope)
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
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while ${path} was in flight`)
  }
  return res
}

// ── device-token fetch (kiosk pre-profile calls) ───────────────────────────────
// Single in-flight device-token refresh per paired-device generation. An old
// response may finish after unpair/re-pair, but can never populate the new pair.
let refreshingDevice: {
  lease: KioskDeviceLease
  promise: Promise<boolean>
} | null = null
function sameKioskDeviceLease(a: KioskDeviceLease, b: KioskDeviceLease): boolean {
  return a.deviceId === b.deviceId && a.deviceSecret === b.deviceSecret &&
    a.generation === b.generation
}
function refreshDeviceToken(lease: KioskDeviceLease | null = currentKioskDeviceLease()): Promise<boolean> {
  if (!lease || !isCurrentKioskDeviceLease(lease)) return Promise.resolve(false)
  if (refreshingDevice && sameKioskDeviceLease(refreshingDevice.lease, lease)) {
    return refreshingDevice.promise
  }
  let attempt: Promise<boolean>
  attempt = fetch('/api/kiosk/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceSecret: lease.deviceSecret }),
    })
      .then(async (res) => {
        if (!res.ok || !isCurrentKioskDeviceLease(lease)) return false
        const d = (await res.json()) as { accessToken: string }
        if (!isCurrentKioskDeviceLease(lease)) return false
        try {
          localStorage.setItem(DEVICE_ACCESS_KEY, JSON.stringify({
            v: 1,
            generation: lease.generation,
            token: d.accessToken,
          }))
        } catch {
          return false
        }
        return isCurrentKioskDeviceLease(lease)
      })
      .catch(() => false)
      .finally(() => {
        if (refreshingDevice?.promise === attempt) refreshingDevice = null
      })
  refreshingDevice = { lease, promise: attempt }
  return attempt
}

// Fetch with the device bearer (mints one if missing) + one refresh-and-retry on
// 401. Keep the captured lease alongside the response so JSON consumers can
// validate again after asynchronous body parsing.
async function deviceFetchWithLease(path: string, init: RequestInit): Promise<{
  response: Response
  lease: KioskDeviceLease
}> {
  const withAuth = (tok?: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  })
  const lease = currentKioskDeviceLease()
  if (!lease) throw new Error('The kiosk device is no longer paired.')
  let tok = getDeviceToken(lease)
  if (!tok) {
    await refreshDeviceToken(lease)
    if (!isCurrentKioskDeviceLease(lease)) throw new Error('The kiosk device changed during the request.')
    tok = getDeviceToken(lease)
  }
  let res = await fetch(path, withAuth(tok))
  if (!isCurrentKioskDeviceLease(lease)) throw new Error('The kiosk device changed during the request.')
  if (res.status === 401) {
    if (await refreshDeviceToken(lease) && isCurrentKioskDeviceLease(lease)) {
      res = await fetch(path, withAuth(getDeviceToken(lease)))
      if (!isCurrentKioskDeviceLease(lease)) throw new Error('The kiosk device changed during the request.')
    } else if (isCurrentKioskDeviceLease(lease)) {
      await clearKioskDevice(lease) // device revoked → back to login
    } else {
      throw new Error('The kiosk device changed during the request.')
    }
  }
  return { response: res, lease }
}

export async function deviceFetch(path: string, init: RequestInit): Promise<Response> {
  return (await deviceFetchWithLease(path, init)).response
}

export async function deviceFetchJson<T>(path: string, init: RequestInit): Promise<{
  response: Response
  body: T
}> {
  const { response, lease } = await deviceFetchWithLease(path, init)
  const body = (await response.json()) as T
  if (!isCurrentKioskDeviceLease(lease)) {
    throw new Error('The kiosk device changed while reading the response.')
  }
  return { response, body }
}

export async function apiGet<T>(path: string): Promise<T> {
  const identityScope = currentIdentityScope()
  const res = await authFetch(path, {}, { identityScope })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  const body = (await res.json()) as T
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while reading ${path}`)
  }
  return body
}

async function apiGetForIdentity<T>(identityScope: string | null, path: string): Promise<T> {
  const res = await authFetch(path, {}, { identityScope })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  const body = (await res.json()) as T
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while reading ${path}`)
  }
  return body
}

// Short-lived GET cache for idempotent, expensive reads (e.g. the AI cards): a
// mount within the TTL reuses the in-flight/last promise instead of firing the
// same request again — so navigating away and back doesn't re-run the model. A
// failed request is evicted so the next mount retries.
export function apiGetCached<T>(path: string, ttlMs: number): Promise<T> {
  const identityScope = currentIdentityScope()
  if (currentViewerAccessExpiredForScope(identityScope)) {
    const session = authSessionSnapshot()
    scheduleEndLostSession(identityScope, session.refreshToken, 'access-expired')
    return Promise.reject(new Error('Household access has expired.'))
  }
  armViewerAccessExpiry(identityScope)
  const hit = getCache.get(path)
  if (hit && hit.identityScope === identityScope && Date.now() - hit.at < ttlMs) {
    return hit.p as Promise<T>
  }
  const p = apiGetForIdentity<T>(identityScope, path)
  getCache.set(path, { identityScope, at: Date.now(), p })
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
  if (verb === 'POST' && (path === '/api/auth/switch' || path === '/api/powersync/crud')) return true
  if (verb === 'PUT' && (path === '/api/account/password' || path === '/api/account/email')) return true
  return verb === 'POST' && /^\/api\/auth\/invites\/[^/]+\/accept$/.test(path)
}

function assertMutationAllowed(method: string, path: string): void {
  const session = authSessionSnapshot()
  if (!documentAcceptsIdentityScope(session.identityScope)) {
    throw new Error(`Principal changed before ${path} could be sent`)
  }
  if (session.identityScope && viewerAccessUpdatePendingScope === session.identityScope) {
    throw new ApiSendError(method, path, 503, {
      error: 'access_policy_pending',
      message: 'Household access is still being verified.',
    })
  }
  if (currentViewerAccessExpiredForScope(session.identityScope)) {
    scheduleEndLostSession(session.identityScope, session.refreshToken, 'access-expired')
    throw new ApiSendError(method, path, 401, {
      error: 'membership_inactive',
      message: 'Household access has expired.',
    })
  }
  syncCurrentViewerAccess(session.identityScope)
  if (viewerMemberType !== 'guest' || guestRequestAllowed(method, path)) return
  throw new ApiSendError(method, path, 403, {
    error: 'Forbidden',
    message: 'Guest access is read-only.',
  })
}

export async function apiSend<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const identityScope = currentIdentityScope()
  assertMutationAllowed(method, path)
  const res = await authFetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  }, { identityScope })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (currentIdentityScope() !== identityScope) {
      throw new Error(`Principal changed while reading ${path}`)
    }
    throw new ApiSendError(method, path, res.status, errBody)
  }
  const responseBody = (await res.json()) as T
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while reading ${path}`)
  }
  return responseBody
}

export async function apiSendForIdentity<T>(
  identityScope: string | null,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  assertMutationAllowed(method, path)
  const res = await authFetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  }, { identityScope })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (currentIdentityScope() !== identityScope) {
      throw new Error(`Principal changed while reading ${path}`)
    }
    throw new ApiSendError(method, path, res.status, errBody)
  }
  const responseBody = (await res.json()) as T
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while reading ${path}`)
  }
  return responseBody
}

export async function apiDelete(path: string): Promise<void> {
  const identityScope = currentIdentityScope()
  assertMutationAllowed('DELETE', path)
  const res = await authFetch(path, { method: 'DELETE' }, { identityScope })
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while ${path} was in flight`)
  }
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`)
}

export async function apiDeleteForIdentity(
  identityScope: string | null,
  path: string
): Promise<void> {
  assertMutationAllowed('DELETE', path)
  const res = await authFetch(path, { method: 'DELETE' }, { identityScope })
  if (currentIdentityScope() !== identityScope) {
    throw new Error(`Principal changed while ${path} was in flight`)
  }
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`)
}

// Local YYYY-MM-DD (kiosk timezone), used to match "tonight" and window the week.
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
