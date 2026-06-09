// Persons (family members) domain — client slice, types, and hook.
import { useEffect, useState } from 'react'
import { apiGet } from './client'

export interface Person {
  id: string
  name: string
  memberType: string
  isAdmin: boolean
  avatarEmoji: string | null
  colorHex: string | null
}

export const personsApi = {
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
    personsApi
      .persons()
      .then((d) => alive && setState({ persons: d.persons, loading: false, error: false }))
      .catch(() => alive && setState({ persons: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [])
  return state
}
