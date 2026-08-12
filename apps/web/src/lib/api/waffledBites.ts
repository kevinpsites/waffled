// Waffled-Bites — client slice (REST). Gated behind the optional `waffledBites`
// module. A device is paired one-per-child, so every call here is scoped by
// personId (to look it up / pair one) or deviceId (once paired).
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

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
  alarm?: { on: boolean; hour: number; min: number; tone: string }
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
  unpair: (deviceId: string) => apiDelete(`/api/waffled-bites/${deviceId}`),
  updateSettings: (deviceId: string, patch: WaffledBiteSettings) =>
    apiSend<{ settings: WaffledBiteSettings }>('PATCH', `/api/waffled-bites/${deviceId}/settings`, patch).then((r) => r.settings),
  quietStart: (deviceId: string, durationSec: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/start`, { durationSec }),
  quietPause: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/pause`, {}),
  quietResume: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/resume`, {}),
  quietAddTime: (deviceId: string, seconds: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/add-time`, { seconds }),
  quietEnd: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/quiet/end`, {}),
  timerStart: (deviceId: string, durationSec: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/timer/start`, { durationSec }),
  timerPause: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/timer/pause`, {}),
  timerResume: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/timer/resume`, {}),
  timerAddTime: (deviceId: string, seconds: number) =>
    apiSend('POST', `/api/waffled-bites/${deviceId}/timer/add-time`, { seconds }),
  timerEnd: (deviceId: string) => apiSend('POST', `/api/waffled-bites/${deviceId}/timer/end`, {}),
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
// How often an open control panel re-reads the device. The device itself polls
// the server every ~5s, so this bounds device→parent latency at roughly 15s.
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
    // Only the FIRST load shows a spinner. The poll below refreshes in place —
    // flipping `loading` every 10s would make the panel flicker forever.
    setLoading(true)
    const load = (first: boolean) =>
      waffledBitesApi
        .get(personId)
        .then((d) => alive && (setDevice(d), first && setLoading(false), setError(false)))
        .catch(() => alive && (setError(true), first && setLoading(false)))

    load(true)

    // Without this the panel fetched once and never again, so anything done ON
    // the device — a kid switching the sound machine on, starting a timer, or
    // the device dropping offline — stayed invisible until the page was
    // reloaded. Parent→device was live via the device's own poll; the reverse
    // direction simply never arrived.
    const timer = setInterval(() => {
      // Don't poll a panel nobody is looking at; refresh on the way back.
      if (typeof document !== 'undefined' && document.hidden) return
      load(false)
    }, WB_POLL_MS)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [personId, nonce])
  return { device, loading, error, refetch: () => setNonce((n) => n + 1) }
}
