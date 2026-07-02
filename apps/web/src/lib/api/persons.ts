// Persons (family members) + household settings — client slice, types, hooks.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap } from './bus'

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
  allergens?: string[]
  rewardStyle?: string
  showOnKiosk?: boolean
  // Resolved capabilities for the *current* caller (from /api/household). Admins &
  // default adults get them all; teen/kid get only what the household grants.
  capabilities?: string[]
}

export interface SettingsMember extends Person {
  hasLogin: boolean
  loginEmail: string | null
  hasPassword: boolean
  hasPin: boolean
  isOwner: boolean
}

// Post-setup onboarding state, stored server-side in households.settings so it
// follows the household across the admin's devices (was per-browser localStorage).
export interface OnboardingState {
  status?: 'active' | 'dismissed'
  opened?: boolean
}

export interface Household {
  id: string
  name: string
  timezone: string
  weekStart: string
  location: string | null
  ownerPersonId: string | null
  settings?: {
    onboarding?: OnboardingState
    modules?: Record<string, boolean>
    pantry?: { locations?: string[]; showOnToday?: boolean }
    chores?: { rewards?: boolean; proofTtlDays?: number }
    familyNight?: { showOnToday?: boolean }
  } & Record<string, unknown>
}

// Every household this account belongs to (incl. the current one) — drives the
// household switcher.
export interface Membership {
  householdId: string
  householdName: string
  personId: string
  isAdmin: boolean
  memberType: string
}

// An outstanding invitation to join another household.
export interface PendingInvite {
  id: string
  householdId: string
  householdName: string
  memberType: string
  isAdmin: boolean
}

export const personsApi = {
  persons: () => apiGet<{ persons: Person[] }>('/api/persons'),
  createPerson: (input: Record<string, unknown>) => apiSend<{ person: Person }>('POST', '/api/persons', input).then((r) => r.person),
  updatePerson: (id: string, patch: Record<string, unknown>) => apiSend<{ person: Person }>('PATCH', `/api/persons/${id}`, patch).then((r) => r.person),
  deletePerson: (id: string) => apiDelete(`/api/persons/${id}`),
  // Member login (admin): give a person an email (enables invite-gated SSO) and,
  // optionally, a password. Omit password to leave it unchanged / invite SSO-only.
  setLogin: (id: string, input: { email: string; password?: string }) =>
    apiSend<{ ok: true }>('PUT', `/api/persons/${id}/login`, input),
  removeLogin: (id: string) => apiDelete(`/api/persons/${id}/login`),
  setSavingToward: (id: string, rewardId: string | null) =>
    apiSend<{ person: Person }>('POST', `/api/persons/${id}/saving-toward`, { rewardId }).then((r) => r.person).then(tap('rewards')),
  household: () =>
    apiGet<{ provisioned: boolean; household?: Household; person?: Person; memberships?: Membership[]; pendingInvites?: PendingInvite[] }>('/api/household'),
  householdSettings: () => apiGet<{ household: Household; members: SettingsMember[] }>('/api/household/settings'),
  updateHousehold: (patch: Record<string, unknown>) => apiSend<{ household: Household }>('PATCH', '/api/household', patch).then((r) => r.household),
  // Advance the "Getting started" onboarding (admins): mark opened / dismiss.
  setOnboarding: (patch: OnboardingState) =>
    apiSend<{ onboarding: OnboardingState | null }>('PATCH', '/api/household/onboarding', patch).then((r) => r.onboarding),
  // Enable/disable optional modules (admins): { pantry: true, … }.
  setModules: (patch: Record<string, boolean>) =>
    apiSend<{ modules: Record<string, boolean> }>('PATCH', '/api/household/modules', patch).then((r) => r.modules),
}

// Notify listeners (e.g. the topbar clock) that household basics changed.
export const HOUSEHOLD_CHANGED = 'nook:household-changed'
export function emitHouseholdChanged(): void {
  try {
    window.dispatchEvent(new Event(HOUSEHOLD_CHANGED))
  } catch {
    /* SSR/no window */
  }
}

// Lightweight household fetch (timezone, name) for the global chrome. Refetches
// when household basics are edited in Settings.
export function useHousehold(): {
  household: Household | null
  person: Person | null
  memberships: Membership[]
  pendingInvites: PendingInvite[]
} {
  const [household, setHousehold] = useState<Household | null>(null)
  const [person, setPerson] = useState<Person | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([])
  useEffect(() => {
    let alive = true
    const load = () =>
      personsApi
        .household()
        .then(
          (d) =>
            alive &&
            (setHousehold(d.household ?? null),
            setPerson(d.person ?? null),
            setMemberships(d.memberships ?? []),
            setPendingInvites(d.pendingInvites ?? [])),
        )
        .catch(() => {})
    load()
    window.addEventListener(HOUSEHOLD_CHANGED, load)
    return () => {
      alive = false
      window.removeEventListener(HOUSEHOLD_CHANGED, load)
    }
  }, [])
  return { household, person, memberships, pendingInvites }
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
