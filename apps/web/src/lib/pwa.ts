import { useEffect, useState } from 'react'

// Register the kiosk service worker (roadmap 7.1). Production only — in dev the
// SW would fight Vite's HMR. Safe to call unconditionally; it no-ops otherwise.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* registration failed — app still works online */
    })
  })
}

// How long the device must be *continuously* offline before the kiosk admits it.
// Brief blips (PowerSync reconnects, network transitions, tab wake-ups) resolve
// well inside this window, so the Offline banner doesn't flash on every hiccup.
export const OFFLINE_BANNER_GRACE_MS = 10_000

// Track connectivity so the kiosk can tell the family it's showing last-known state.
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

// Debounced offline signal for the banner: flips true only after the device has
// been continuously offline for the grace period (a reconnect cancels the pending
// flip and restarts the clock), and flips back false immediately on reconnect.
export function useSustainedOffline(graceMs: number = OFFLINE_BANNER_GRACE_MS): boolean {
  const online = useOnline()
  const [sustained, setSustained] = useState(false)
  useEffect(() => {
    if (online) {
      setSustained(false)
      return
    }
    const timer = window.setTimeout(() => setSustained(true), graceMs)
    return () => window.clearTimeout(timer)
  }, [online, graceMs])
  return sustained
}
