// Kiosk client slice: device pairing, the profile picker, claiming a profile
// (which sets the ephemeral profile session), and per-person PIN management.
// Device-authed calls use deviceFetch (the device bearer); admin calls use the
// normal authFetch-backed apiSend.
//
// ⚠️ KEEP IN SYNC with the iOS shared-kiosk port — endpoints, request bodies, and
// status codes (401 triesLeft / 429 retryAfter) must match:
//   apps/ios/Sources/Nook/Sync/KioskDevice.swift   (device-secret + token exchange)
//   apps/ios/Sources/Nook/Sync/KioskMode.swift     (gate state machine)
//   apps/ios/Sources/Nook/Sync/NookAPI.swift        (kiosk endpoints)
//   apps/ios/Sources/Nook/Features/Kiosk/KioskProfilePickerView.swift  (picker + PIN pad)
import {
  apiGet,
  apiSend,
  apiDelete,
  commitKioskDeviceUnderLocks,
  currentIdentityScope,
  currentKioskDeviceLease,
  deviceFetch,
  deviceFetchJson,
  enterKioskMode,
  getAccessToken,
  isCurrentKioskDeviceLease,
  setSession,
} from './client'
import {
  originWideLockingAvailable,
  withKioskDeviceLock,
  withPrincipalUseLock,
} from '../powersync/principal-transition'

export interface DisplayConfig {
  screensaverMinutes: number
  content: 'photos' | 'clock' | 'off'
  returnToPicker: boolean
  resetHomeMinutes: number
  nightDim: { enabled: boolean; start: string; end: string }
  // Photo-playback options for the photos screensaver.
  photoSource: 'all' | 'favorites' | 'album'
  photoAlbum: string | null
  photoInterval: number
  photoShuffle: boolean
}

export interface KioskDevice {
  id: string
  label: string
  lastSeenAt: string | null
  createdAt: string
}

export interface KioskProfile {
  id: string
  name: string
  memberType: string
  isAdmin: boolean
  avatarType?: string
  avatarEmoji: string | null
  avatarUrl?: string | null
  colorHex: string | null
  hasPin: boolean
}

// Thrown by claim() so the PIN pad can distinguish "wrong PIN" (401) from
// "locked out" (429, with a retry hint).
export class KioskClaimError extends Error {
  status: number
  retryAfter?: number
  triesLeft?: number
  constructor(status: number, message: string, opts?: { retryAfter?: number; triesLeft?: number }) {
    super(message)
    this.name = 'KioskClaimError'
    this.status = status
    this.retryAfter = opts?.retryAfter
    this.triesLeft = opts?.triesLeft
  }
}

function deviceGenerationIsCurrent(
  expected: ReturnType<typeof currentKioskDeviceLease>
): boolean {
  return expected ? isCurrentKioskDeviceLease(expected) : currentKioskDeviceLease() == null
}

export const kioskApi = {
  // Public: claim a pairing code → store the device secret (does NOT navigate yet, so
  // the pairing screen can run its "name this kiosk" step; call enterKioskMode after).
  async pair(code: string): Promise<void> {
    // Pairing codes are one-use and the POST creates a durable server device. Do
    // not consume one when this browser cannot serialize the corresponding local
    // device-principal commit origin-wide.
    if (!originWideLockingAvailable()) {
      throw new Error('This browser cannot safely change the shared kiosk device.')
    }
    const expectedIdentityScope = currentIdentityScope()
    const expectedDevice = currentKioskDeviceLease()
    await withKioskDeviceLock(() => withPrincipalUseLock(async () => {
      // Validate the invocation's snapshot only after both locks are held. A
      // second tab which queued behind a successful pair must stop here without
      // consuming another one-use code or creating an unreachable server device.
      if (currentIdentityScope() !== expectedIdentityScope) {
        throw new Error('The active account changed while pairing.')
      }
      if (!deviceGenerationIsCurrent(expectedDevice)) {
        throw new Error('The kiosk device changed while pairing.')
      }
      const res = await fetch('/api/kiosk/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(err.message || 'That pairing code didn’t work.')
      }
      const d = (await res.json()) as { deviceSecret: string; deviceId: string }
      commitKioskDeviceUnderLocks(d.deviceSecret, d.deviceId, {
        expectedLease: expectedDevice,
        expectedIdentityScope,
      })
    }))
  },
  enterKiosk: () => enterKioskMode(),

  // Admin shortcut (uses the current admin session): turn this device into a kiosk.
  // Returns the new device id so the caller can prompt to name it.
  async promote(): Promise<string> {
    const expectedIdentityScope = currentIdentityScope()
    const expectedDevice = currentKioskDeviceLease()
    const deviceId = await withKioskDeviceLock(() => withPrincipalUseLock(async () => {
      if (currentIdentityScope() !== expectedIdentityScope || !deviceGenerationIsCurrent(expectedDevice)) {
        throw new Error('The active account or kiosk device changed while pairing.')
      }
      const d = await apiSend<{ deviceSecret: string; deviceId: string }>('POST', '/api/kiosk/promote', {})
      commitKioskDeviceUnderLocks(d.deviceSecret, d.deviceId, {
        expectedLease: expectedDevice,
        expectedIdentityScope,
      })
      return d.deviceId
    }))
    enterKioskMode()
    return deviceId
  },

  // Device-authed: this kiosk's display label + the profiles shown in the picker.
  async profiles(): Promise<{ deviceLabel: string; profiles: KioskProfile[] }> {
    const { response, body } = await deviceFetchJson<{ deviceLabel: string; profiles: KioskProfile[] }>(
      '/api/kiosk/profiles',
      {}
    )
    if (!response.ok) throw new Error(`profiles -> ${response.status}`)
    return body
  },

  // Device-authed: a just-paired device names itself (post-pair step).
  setDeviceLabel: (label: string) => deviceFetch('/api/kiosk/device/label', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }),
  }).then((r) => { if (!r.ok) throw new Error('Could not name this kiosk.') }),

  // Device-authed: claim a profile → ephemeral profile session (setSession fires
  // waffled:auth-changed → the gate flips to the app, acting as that person).
  async claim(personId: string, pin?: string): Promise<void> {
    const deviceLease = currentKioskDeviceLease()
    if (!deviceLease) throw new Error('The kiosk device is no longer paired.')
    const expectedIdentityScope = currentIdentityScope()
    const { response, body } = await deviceFetchJson<{
      accessToken?: string
      refreshToken?: string
      person?: { memberType?: string | null; accessExpiresAt?: string | null }
      message?: string
      retryAfter?: number
      triesLeft?: number
    }>(`/api/kiosk/profile/${personId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pin !== undefined ? { pin } : {}),
    })
    if (!response.ok) {
      throw new KioskClaimError(response.status, body.message || 'Could not switch profiles.', { retryAfter: body.retryAfter, triesLeft: body.triesLeft })
    }
    if (!body.accessToken || !body.refreshToken) throw new Error('The kiosk returned an invalid profile session.')
    const accessToken = body.accessToken
    const refreshToken = body.refreshToken
    const viewerAccess = body.person && Object.prototype.hasOwnProperty.call(body.person, 'memberType')
      ? { memberType: body.person.memberType ?? null } as {
          memberType: string | null
          accessExpiresAt?: string | null
        }
      : undefined
    // Preserve property presence: permanent roles may omit a deadline, while an
    // omitted caregiver/guest deadline is unknown and must fail closed.
    if (viewerAccess && Object.prototype.hasOwnProperty.call(body.person, 'accessExpiresAt')) {
      viewerAccess.accessExpiresAt = body.person?.accessExpiresAt
    }
    // Stabilize the device generation through the profile-session commit. Device
    // replacement and unpair use this same kiosk -> principal lock order, so a
    // response minted for A can never land beside a newly paired device B.
    await withKioskDeviceLock(async () => {
      if (!isCurrentKioskDeviceLease(deviceLease)) {
        throw new Error('The kiosk device changed while claiming the profile.')
      }
      await setSession(accessToken, refreshToken, {
        expectedIdentityScope,
        stillCurrent: () => isCurrentKioskDeviceLease(deviceLease),
        viewerAccess,
      })
    })
  },

  async heartbeat(): Promise<void> {
    await deviceFetch('/api/kiosk/heartbeat', { method: 'POST' }).catch(() => {})
  },

  // Per-person PIN (self or admin). 4–8 digits.
  setPin: (personId: string, pin: string) => apiSend<{ ok: true }>('PUT', `/api/persons/${personId}/pin`, { pin }),
  clearPin: (personId: string) => apiDelete(`/api/persons/${personId}/pin`),

  // ── device management (admin; Settings → Display & Kiosk) ──────────────────────
  devices: () => apiGet<{ devices: KioskDevice[] }>('/api/kiosk/devices').then((r) => r.devices),
  createPairingCode: (label?: string) =>
    apiSend<{ code: string; label: string; expiresAt: string }>('POST', '/api/kiosk/pairing-code', { label }),
  renameDevice: (id: string, label: string) => apiSend<{ ok: true }>('PATCH', `/api/kiosk/devices/${id}`, { label }),
  revokeDevice: (id: string) => apiDelete(`/api/kiosk/devices/${id}`),

  // ── display / screensaver settings ─────────────────────────────────────────────
  // Dual-auth GET: use the profile token when signed in, else the device token.
  async displayConfig(): Promise<DisplayConfig> {
    if (getAccessToken()) return apiGet<DisplayConfig>('/api/kiosk/display')
    const { response, body } = await deviceFetchJson<DisplayConfig>('/api/kiosk/display', {})
    if (!response.ok) throw new Error(`display -> ${response.status}`)
    return body
  },
  setDisplayConfig: (patch: Partial<DisplayConfig>) => apiSend<DisplayConfig>('PUT', '/api/kiosk/display', patch),
}
