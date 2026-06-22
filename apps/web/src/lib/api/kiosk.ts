// Kiosk client slice: device pairing, the profile picker, claiming a profile
// (which sets the ephemeral profile session), and per-person PIN management.
// Device-authed calls use deviceFetch (the device bearer); admin calls use the
// normal authFetch-backed apiSend.
import { apiGet, apiSend, apiDelete, deviceFetch, setKioskDevice, setSession } from './client'

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

export const kioskApi = {
  // Public: claim a pairing code → store the device secret + enter kiosk mode.
  async pair(code: string, label?: string): Promise<void> {
    const res = await fetch('/api/kiosk/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), label }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string }
      throw new Error(err.message || 'That pairing code didn’t work.')
    }
    const d = (await res.json()) as { deviceSecret: string; deviceId: string }
    setKioskDevice(d.deviceSecret, d.deviceId)
  },

  // Admin shortcut (uses the current admin session): turn this device into a kiosk.
  async promote(label?: string): Promise<void> {
    const d = await apiSend<{ deviceSecret: string; deviceId: string }>('POST', '/api/kiosk/promote', { label })
    setKioskDevice(d.deviceSecret, d.deviceId)
  },

  // Device-authed: the profiles shown in the picker.
  async profiles(): Promise<KioskProfile[]> {
    const res = await deviceFetch('/api/kiosk/profiles', {})
    if (!res.ok) throw new Error(`profiles -> ${res.status}`)
    return ((await res.json()) as { profiles: KioskProfile[] }).profiles
  },

  // Device-authed: claim a profile → ephemeral profile session (setSession fires
  // nook:auth-changed → the gate flips to the app, acting as that person).
  async claim(personId: string, pin?: string): Promise<void> {
    const res = await deviceFetch(`/api/kiosk/profile/${personId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pin !== undefined ? { pin } : {}),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; retryAfter?: number; triesLeft?: number }
      throw new KioskClaimError(res.status, body.message || 'Could not switch profiles.', { retryAfter: body.retryAfter, triesLeft: body.triesLeft })
    }
    const d = (await res.json()) as { accessToken: string; refreshToken: string }
    setSession(d.accessToken, d.refreshToken)
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
}
