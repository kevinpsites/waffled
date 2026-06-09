// Persons (family members) + household settings — client slice, types, hooks.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

export interface Person {
  id: string
  name: string
  memberType: string
  isAdmin: boolean
  avatarType?: string
  avatarEmoji: string | null
  avatarUrl?: string | null
  colorHex: string | null
  paletteSlot?: string | null
  birthday?: string | null
  dietaryNotes?: string | null
  rewardStyle?: string
  showOnKiosk?: boolean
}

export interface SettingsMember extends Person {
  hasLogin: boolean
  isOwner: boolean
}

export interface Household {
  id: string
  name: string
  timezone: string
  weekStart: string
  ownerPersonId: string | null
}

export const personsApi = {
  persons: () => apiGet<{ persons: Person[] }>('/api/persons'),
  createPerson: (input: Record<string, unknown>) => apiSend<{ person: Person }>('POST', '/api/persons', input).then((r) => r.person),
  updatePerson: (id: string, patch: Record<string, unknown>) => apiSend<{ person: Person }>('PATCH', `/api/persons/${id}`, patch).then((r) => r.person),
  deletePerson: (id: string) => apiDelete(`/api/persons/${id}`),
  householdSettings: () => apiGet<{ household: Household; members: SettingsMember[] }>('/api/household/settings'),
  updateHousehold: (patch: Record<string, unknown>) => apiSend<{ household: Household }>('PATCH', '/api/household', patch).then((r) => r.household),
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

export interface SettingsState {
  household: Household | null
  members: SettingsMember[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useHouseholdSettings(): SettingsState {
  const [household, setHousehold] = useState<Household | null>(null)
  const [members, setMembers] = useState<SettingsMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    personsApi
      .householdSettings()
      .then((d) => alive && (setHousehold(d.household), setMembers(d.members), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  return { household, members, loading, error, refetch: () => setNonce((n) => n + 1) }
}
