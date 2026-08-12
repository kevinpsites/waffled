// Waffled-Bites — client slice (REST). Gated behind the optional `waffledBites`
// module. A device is paired one-per-child, so every call here is scoped by
// personId (to look it up / pair one) or deviceId (once paired).
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap, useRefetchOn, useLiveRefresh } from './bus'

export interface WaffledBiteTask {
  id: string
  choreId: string
  choreTitle: string
  emoji: string | null
  dueTime: string | null
  status: string
  rewardAmount: number | null
  rewardCurrency: string | null
}

export interface WaffledBiteQuiet {
  active: boolean
  running: boolean
  remainingSec: number
  durationSec: number
}

// Same shape as WaffledBiteQuiet — unlike quiet time, a timer can also be
// started/ended by the kid directly on the device (see the device-authed
// /api/waffled-bites/device/timer/* routes), and isn't full-screen-locked.
export type WaffledBiteTimer = WaffledBiteQuiet

export interface WaffledBiteSchedule {
  days: number[] // 0 (Sun) – 6 (Sat) — the WAKE morning; bedtimeMin is the evening BEFORE this day
  wakeMin: number // minutes since midnight the light turns green
  leadMin: number // minutes before wakeMin the light turns yellow
  bedtimeMin?: number // minutes since midnight, the night before wakeMin, sleep starts (undefined = this rule never force-locks the device)
}

export type WaffledBiteWakeLightState = 'none' | 'sleep' | 'warn' | 'wake'
export interface WaffledBiteWakeLight {
  state: WaffledBiteWakeLightState
  wakeAtHour?: number
  wakeAtMinute?: number
}

export interface WaffledBiteSettings {
  night?: { on: boolean; color: string; brightness: number }
  sound?: { on: boolean; sound: string; volume: number; timerMin: number }
  // `volume` is deliberately separate from sound.volume (decision D3) — a wake
  // tone has to be heard through sleep, where a sound machine has to be
  // ignorable. `tone` is a display string ('Sunrise chime'); the device also
  // accepts stable keys, so migrating it later needs no firmware change.
  alarm?: { on: boolean; hour: number; min: number; tone: string; volume: number }
  schedules?: WaffledBiteSchedule[]
  display?: { brightness: number; nightDim: boolean }
}

export interface WaffledBiteDevice {
  id: string
  label: string
  settings: WaffledBiteSettings
  runtimeState: { quiet: WaffledBiteQuiet; timer: WaffledBiteTimer; wakeLight: WaffledBiteWakeLight }
  lastSeenAt: string | null
  createdAt: string
}

export const waffledBitesApi = {
  get: (personId: string) =>
    apiGet<{ device: WaffledBiteDevice | null }>(`/api/persons/${personId}/waffled-bite`).then((r) => r.device),
  mintPairingCode: (personId: string, label?: string) =>
    apiSend<{ code: string; personId: string; expiresAt: string }>('POST', `/api/persons/${personId}/waffled-bite/pairing-code`, { label }),
  // Every mutation taps the `waffledBites` topic so other surfaces showing the
  // same device in this tab (the person profile's card, the control panel)
  // refresh without waiting for a poll. The topic already existed in bus.ts;
  // nothing had ever emitted it.
  unpair: (deviceId: string) => apiDelete(`/api/waffled-bites/${deviceId}`).then(tap('waffledBites')),
  updateSettings: (deviceId: string, patch: WaffledBiteSettings) =>
    apiSend<{ settings: WaffledBiteSettings }>('PATCH', `/api/waffled-bites/${deviceId}/settings`, patch)
      .then((r) => r.settings)
      .then(tap('waffledBites')),
  quietStart: (deviceId: string, durationSec: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/start`, { durationSec }).then(tap('waffledBites')),
  quietPause: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/pause`, {}).then(tap('waffledBites')),
  quietResume: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/resume`, {}).then(tap('waffledBites')),
  quietAddTime: (deviceId: string, seconds: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/add-time`, { seconds }).then(tap('waffledBites')),
  quietEnd: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/end`, {}).then(tap('waffledBites')),
  timerStart: (deviceId: string, durationSec: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/timer/start`, { durationSec }).then(tap('waffledBites')),
  timerPause: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/timer/pause`, {}).then(tap('waffledBites')),
  timerResume: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/timer/resume`, {}).then(tap('waffledBites')),
  timerAddTime: (deviceId: string, seconds: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/timer/add-time`, { seconds }).then(tap('waffledBites')),
  timerEnd: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/timer/end`, {}).then(tap('waffledBites')),
  nudge: (deviceId: string, message: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/nudge`, { message }),
}

export interface WaffledBiteDeviceState {
  device: WaffledBiteDevice | null
  loading: boolean
  error: boolean
  refetch: () => void
}

// Mirrors usePersonOverview/usePantry's shape: plain useState+useEffect+nonce, no
// mutation-hook abstraction — callers refetch() after a successful mutation.
// Tighter than useLiveRefresh's 20s default: this panel is a live remote
// control for a device the kid is touching, not a shopping list. The device
// polls the server every ~5s, so 10s here bounds device→parent at roughly 15s.
const WB_POLL_MS = 10_000

export function useWaffledBiteDevice(personId: string | null): WaffledBiteDeviceState {
  const [device, setDevice] = useState<WaffledBiteDevice | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!personId) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    waffledBitesApi
      .get(personId)
      .then((d) => alive && (setDevice(d), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [personId, nonce])
  // Same tab, other surface (the person profile's device card) — instant.
  //
  // Callers ALSO do `mutation().then(refetch)`, which looks like it would
  // double-fetch, since the mutation taps this same topic. It doesn't: both
  // paths call setNonce, React batches them into one render, and the effect
  // above runs once. Measured, not assumed — one mutation, one GET.
  //
  // Both are kept on purpose, because they answer different questions. The
  // explicit refetch is a screen's own correctness ("I changed this, reload
  // it") and holds even if the tap is later removed; the topic is how OTHER
  // surfaces find out. Dropping the refetches would make every screen depend
  // on the bus being wired right for its own display to be correct.
  useRefetchOn(['waffledBites'], () => {
    if (personId) setNonce((n) => n + 1)
  })
  // Cross-device liveness. Without it the panel fetched once and never again,
  // so anything done ON the device — a kid switching the sound machine on,
  // starting a timer, the device dropping offline — stayed invisible until a
  // reload: parent→device was live via the device's own poll, while the
  // reverse direction never arrived. Also refetches the moment the tab regains
  // focus, which a bare interval doesn't.
  useLiveRefresh(() => {
    if (personId) setNonce((n) => n + 1)
  }, WB_POLL_MS)
  return { device, loading, error, refetch: () => setNonce((n) => n + 1) }
}
