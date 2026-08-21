import { useEffect, useState } from 'react'

// Register the kiosk service worker (roadmap 7.1). Production only — in dev the
// SW would fight Vite's HMR. Safe to call unconditionally; it no-ops otherwise.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  reloadOnWorkerTakeover()
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* registration failed — app still works online */
    })
  })
}

// Reload once when a new build's worker takes control of this page.
//
// The screens are code-split, so a page left open across a deploy still holds chunk
// URLs from the build it started on. The incoming worker deletes that build's asset
// cache (cache names carry the build stamp), and Caddy answers the missing chunk with
// index.html, so the next navigation fails its module load and lands on ScreenBoundary.
// A wall-mounted display has nobody standing there to tap Reload, so it would sit on
// the error card indefinitely. Picking up the new build immediately avoids the whole
// situation.
//
// The container and reload are parameters so this is testable without a real service
// worker or a navigating jsdom; production always uses the defaults.
export function reloadOnWorkerTakeover(
  container: ServiceWorkerContainer = navigator.serviceWorker,
  reload: () => void = () => window.location.reload()
): void {
  // No existing controller means this is the first worker ever claiming the page,
  // not an upgrade. The page came off the network moments ago and holds nothing
  // stale, so reloading there would just bounce every first-time visitor.
  const wasControlled = Boolean(container.controller)
  let reloaded = false
  container.addEventListener('controllerchange', () => {
    if (!wasControlled || reloaded) return
    reloaded = true
    reload()
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
      // Reset the stored flag so the next outage starts hidden; the return
      // below already hides the banner synchronously on this very render.
      setSustained(false)
      return
    }
    const timer = window.setTimeout(() => setSustained(true), graceMs)
    return () => window.clearTimeout(timer)
  }, [online, graceMs])
  // Clear in-render, not in the post-paint effect — otherwise the banner
  // paints one stale frame on the render where connectivity returns.
  return online ? false : sustained
}
