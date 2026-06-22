// In kiosk mode, return to the profile picker after a stretch of no interaction so
// a walk-away doesn't leave someone's profile (and their permissions) open. Revokes
// the profile refresh server-side; the device stays paired. No-op outside kiosk mode.
import { useEffect } from 'react'
import { isKioskMode, authApi } from '../lib/api'

const IDLE_MS = Number(import.meta.env.VITE_KIOSK_IDLE_MS) || 2 * 60 * 1000 // 2 min

export function useIdleReturn(): void {
  useEffect(() => {
    if (!isKioskMode()) return
    let timer: ReturnType<typeof setTimeout>
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void authApi.logout(), IDLE_MS) // → picker (device kept)
    }
    const events = ['pointerdown', 'keydown', 'pointermove', 'wheel', 'touchstart']
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => {
      clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [])
}
