// Weather domain — current conditions for the kiosk topbar (6.8). Server-side
// (Open-Meteo, no key); we just fetch + refresh and re-poll when the household
// location changes in Settings.
import { useEffect, useState } from 'react'
import { apiGet } from './client'
import { HOUSEHOLD_CHANGED } from './persons'

export interface Weather {
  configured: boolean
  tempF?: number
  code?: number
  label?: string
  emoji?: string
  isDay?: boolean
  location?: string
}

const REFRESH_MS = 10 * 60 * 1000

export const weatherApi = {
  current: () => apiGet<Weather>('/api/weather'),
}

export function useWeather(): Weather | null {
  const [wx, setWx] = useState<Weather | null>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      weatherApi
        .current()
        .then((w) => alive && setWx(w))
        .catch(() => alive && setWx(null))
    load()
    const id = setInterval(load, REFRESH_MS)
    window.addEventListener(HOUSEHOLD_CHANGED, load) // location may change in Settings
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener(HOUSEHOLD_CHANGED, load)
    }
  }, [])
  return wx
}
