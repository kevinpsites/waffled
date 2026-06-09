import { useEffect, useState } from 'react'

// Minimal api client. In dev, Vite proxies /api to the api container; in the
// stack, Caddy does. The kiosk token is a dev shortcut for now — a real device
// pairing flow (chunk 3.3) replaces it later. Set it via localStorage
// ('nook.token') at runtime, or VITE_KIOSK_TOKEN at build time.
function token(): string | undefined {
  try {
    const t = localStorage.getItem('nook.token')
    if (t) return t
  } catch {
    /* localStorage unavailable */
  }
  return import.meta.env.VITE_KIOSK_TOKEN || undefined
}

async function apiGet<T>(path: string): Promise<T> {
  const t = token()
  const res = await fetch(path, { headers: t ? { authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export interface Person {
  id: string
  name: string
  memberType: string
  isAdmin: boolean
  avatarEmoji: string | null
  colorHex: string | null
}

export const api = {
  persons: () => apiGet<{ persons: Person[] }>('/api/persons'),
}

export interface PersonsState {
  persons: Person[]
  loading: boolean
  error: boolean
}

export function usePersons(): PersonsState {
  const [state, setState] = useState<PersonsState>({ persons: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    api
      .persons()
      .then((d) => alive && setState({ persons: d.persons, loading: false, error: false }))
      .catch(() => alive && setState({ persons: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [])
  return state
}
