// Role-based capability model. Replaces the binary is_admin gate for chores and
// rewards with a configurable per-role matrix stored in households.settings.permissions.
// Admins always have every capability; the matrix only governs non-admin members
// (typically the second adult, or teens given a longer leash). The defaults are
// conservative: only adults manage/approve out of the box.
import { AuthError } from './auth'
import { query } from './db'
import type { Tenant } from '../modules/households/households'
import type { PoolClient } from 'pg'

export type Capability = 'chore.manage' | 'chore.approve' | 'reward.manage' | 'reward.approve' | 'reward.grant' | 'reward.correct' | 'goal.manage'
export const CAPABILITIES: Capability[] = ['chore.manage', 'chore.approve', 'reward.manage', 'reward.approve', 'reward.grant', 'reward.correct', 'goal.manage']

export type MemberRole = 'adult' | 'caregiver' | 'guest' | 'teen' | 'kid'
export const ROLES: MemberRole[] = ['adult', 'caregiver', 'guest', 'teen', 'kid']

// adult = full rights; caregiver = routine operational rights; teen/kid = nothing
// until an admin grants it; guest remains hard read-only.
export const DEFAULT_PERMISSIONS: Record<MemberRole, Record<Capability, boolean>> = {
  adult: { 'chore.manage': true, 'chore.approve': true, 'reward.manage': true, 'reward.approve': true, 'reward.grant': true, 'reward.correct': true, 'goal.manage': true },
  caregiver: { 'chore.manage': true, 'chore.approve': true, 'reward.manage': false, 'reward.approve': true, 'reward.grant': false, 'reward.correct': false, 'goal.manage': false },
  guest: { 'chore.manage': false, 'chore.approve': false, 'reward.manage': false, 'reward.approve': false, 'reward.grant': false, 'reward.correct': false, 'goal.manage': false },
  teen: { 'chore.manage': false, 'chore.approve': false, 'reward.manage': false, 'reward.approve': false, 'reward.grant': false, 'reward.correct': false, 'goal.manage': false },
  kid: { 'chore.manage': false, 'chore.approve': false, 'reward.manage': false, 'reward.approve': false, 'reward.grant': false, 'reward.correct': false, 'goal.manage': false },
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Deep-merge stored settings.permissions over the defaults, cell by cell. Unknown
// roles/capabilities and non-boolean values are ignored — the result is always a
// complete, well-typed matrix regardless of what junk is on file.
export function getPermissions(settings: unknown): Record<MemberRole, Record<Capability, boolean>> {
  const out: Record<MemberRole, Record<Capability, boolean>> = {
    adult: { ...DEFAULT_PERMISSIONS.adult },
    caregiver: { ...DEFAULT_PERMISSIONS.caregiver },
    guest: { ...DEFAULT_PERMISSIONS.guest },
    teen: { ...DEFAULT_PERMISSIONS.teen },
    kid: { ...DEFAULT_PERMISSIONS.kid },
  }
  const stored = isObject(settings) ? settings.permissions : undefined
  if (!isObject(stored)) return out
  for (const role of ROLES) {
    const row = stored[role]
    if (!isObject(row)) continue
    for (const cap of CAPABILITIES) {
      // Guest is a hard read-only role. Ignore any stale or hand-edited settings
      // that try to grant it a mutation capability.
      if (role !== 'guest' && typeof row[cap] === 'boolean') out[role][cap] = row[cap] as boolean
    }
  }
  return out
}

function asRole(memberType: string): MemberRole | null {
  return (ROLES as string[]).includes(memberType) ? (memberType as MemberRole) : null
}

// Admin ⇒ always allowed. Otherwise look up the role's cell; an unknown/invalid
// role has no capabilities.
export function can(memberType: string, isAdmin: boolean, cap: Capability, settings: unknown): boolean {
  if (memberType === 'guest') return false
  if (isAdmin) return true
  const role = asRole(memberType)
  if (!role) return false
  return getPermissions(settings)[role][cap]
}

// The full list of capabilities a person holds (admin ⇒ all). Powers the
// `capabilities` field on /api/household so clients can gate UI without guessing.
export function resolveCapabilities(memberType: string, isAdmin: boolean, settings: unknown): Capability[] {
  if (memberType === 'guest') return []
  if (isAdmin) return [...CAPABILITIES]
  const role = asRole(memberType)
  if (!role) return []
  const perms = getPermissions(settings)[role]
  return CAPABILITIES.filter((cap) => perms[cap])
}

// Route guard: admins pass immediately; everyone else is checked against the
// household's stored matrix for their member_type. Throws 403 on a miss.
export async function requireCapability(tenant: Tenant, cap: Capability, client?: PoolClient): Promise<void> {
  if (tenant.isAdmin) return
  const sql = `select settings from households where id = $1`
  const params = [tenant.householdId]
  const { rows } = client
    ? await client.query<{ settings: unknown }>(sql, params)
    : await query<{ settings: unknown }>(sql, params)
  if (!can(tenant.memberType, tenant.isAdmin, cap, rows[0]?.settings)) {
    throw new AuthError('You do not have permission to do this', 403)
  }
}
