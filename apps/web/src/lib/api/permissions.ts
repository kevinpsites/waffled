// Role-based capabilities — the things a household can grant beyond the
// always-allowed self-serve actions. Admins (and default adults) get them all
// baked into person.capabilities server-side, so `can()` needs no special-casing.
import { apiGet, apiSend } from './client'

export const CAPABILITIES = ['chore.manage', 'chore.approve', 'reward.manage', 'reward.approve', 'goal.manage'] as const
export type Capability = (typeof CAPABILITIES)[number]

export type Role = 'adult' | 'teen' | 'kid'
export type PermissionMatrix = Record<Role, Record<Capability, boolean>>

// Friendly labels for the Settings grid (rows = roles, cols = capabilities).
export const CAPABILITY_LABELS: Record<Capability, string> = {
  'chore.manage': 'Manage chores',
  'chore.approve': 'Approve chores',
  'reward.manage': 'Manage rewards',
  'reward.approve': 'Approve redemptions',
  'goal.manage': 'Manage goals',
}
export const ROLE_LABELS: Record<Role, string> = { adult: 'Adult', teen: 'Teen', kid: 'Kid' }

// `can(person, cap)` — does this person hold the capability. A null person (not yet
// loaded) is treated as no — gate UI conservatively until we know.
export function can(person: { capabilities?: string[] } | null, cap: Capability): boolean {
  return !!person?.capabilities?.includes(cap)
}

export const permissionsApi = {
  getPermissions: () =>
    apiGet<{ permissions: PermissionMatrix; capabilities: Capability[]; roles: Role[] }>('/api/permissions'),
  setPermissions: (permissions: PermissionMatrix) =>
    apiSend<{ permissions: PermissionMatrix }>('PUT', '/api/permissions', { permissions }).then((r) => r.permissions),
}
