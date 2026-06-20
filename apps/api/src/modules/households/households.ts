// Identity resolution + first-login provisioning.
// The identities table maps a token's `sub` → person → household; that mapping
// (not the JWT) is the authority for which household a caller belongs to.
import type { QueryResultRow } from 'pg'
import type { Request } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { AuthError } from '../../platform/auth'

export interface Tenant {
  sub: string
  personId: string
  householdId: string
  isAdmin: boolean
}

export interface HouseholdRow extends QueryResultRow {
  id: string
  name: string
  timezone: string
  week_start: string
  location: string | null
  owner_person_id: string | null
  settings: unknown
  created_at: Date
  updated_at: Date
}

export interface PersonRow extends QueryResultRow {
  id: string
  household_id: string
  name: string
  member_type: string
  is_admin: boolean
  avatar_type: string
  avatar_emoji: string | null
  avatar_url: string | null
  color_hex: string | null
  palette_slot: string | null
  birthday: string | null
  dietary_notes: string | null
  reward_style: string
  show_on_kiosk: boolean
  sort_order: number
  created_at: Date
}

// Best-effort provider from the Auth0-style sub prefix (e.g. google-oauth2|123).
export function inferProvider(sub: string): string {
  if (sub.startsWith('google')) return 'google'
  if (sub.startsWith('apple')) return 'apple'
  return 'password'
}

// Resolve the caller's household, or 403 if they haven't onboarded yet.
export async function requireTenant(req: Request): Promise<Tenant> {
  const tenant = await findTenantBySub(req.principal!.sub)
  if (!tenant) throw new AuthError('No household for this account; create one first', 403)
  return tenant
}

// Gate mutations on admin rights (owner + other admins; teens/kids never).
export function requireAdmin(tenant: Tenant): void {
  if (!tenant.isAdmin) throw new AuthError('Admin privileges required', 403)
}

export async function findTenantBySub(sub: string): Promise<Tenant | null> {
  const { rows } = await query<{ person_id: string; household_id: string; is_admin: boolean }>(
    `select i.person_id, p.household_id, p.is_admin
       from identities i
       join persons p on p.id = i.person_id and p.deleted_at is null
      where i.auth0_user_id = $1 and i.deleted_at is null`,
    [sub]
  )
  const r = rows[0]
  return r ? { sub, personId: r.person_id, householdId: r.household_id, isAdmin: r.is_admin } : null
}

// Invite-gated OIDC: a first-time SSO login only succeeds if its verified email
// already belongs to a person on file (added by an admin / created at setup). We
// match against both login surfaces — a password credential's email and any
// identity's email — so e.g. the setup admin can SSO in by their setup email.
export async function findPersonByEmail(
  email: string
): Promise<{ personId: string; householdId: string } | null> {
  const { rows } = await query<{ person_id: string; household_id: string }>(
    `select person_id, household_id from credentials
       where lower(email) = lower($1) and deleted_at is null
     union
     select i.person_id, p.household_id
       from identities i join persons p on p.id = i.person_id and p.deleted_at is null
      where lower(i.email) = lower($1) and i.deleted_at is null
     limit 1`,
    [email]
  )
  const r = rows[0]
  return r ? { personId: r.person_id, householdId: r.household_id } : null
}

// Link a new auth identity (e.g. OIDC) to an existing person, so subsequent logins
// resolve straight through findTenantBySub. is_primary stays false — the original
// (password/setup) identity remains primary.
export async function linkIdentity(input: {
  householdId: string
  personId: string
  provider: string
  subject: string
  email: string | null
  emailVerified: boolean
}): Promise<void> {
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary)
     values ($1, $2, $3, $4, $5, $6, false)`,
    [input.householdId, input.personId, input.provider, input.subject, input.email, input.emailVerified]
  )
}

export async function getContext(
  tenant: Tenant
): Promise<{ household: HouseholdRow; person: PersonRow }> {
  const h = await query<HouseholdRow>(`select * from households where id = $1`, [tenant.householdId])
  const p = await query<PersonRow>(`select * from persons where id = $1`, [tenant.personId])
  return { household: h.rows[0], person: p.rows[0] }
}

export interface ProvisionInput {
  sub: string
  provider: string
  email: string | null
  emailVerified: boolean
  householdName: string
  timezone: string
  person: { name: string; avatarEmoji: string | null; colorHex: string | null }
  // Built-in password setup: create a credentials row (id = sub) in the same
  // transaction so login can resolve email → subject.
  credential?: { email: string; passwordHash: string }
}

// Creates household + owner person (adult, admin) + identity in one transaction.
// A duplicate sub raises a unique violation (23505) the route maps to 409.
export async function provisionHousehold(
  input: ProvisionInput
): Promise<{ household: HouseholdRow; person: PersonRow }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')

    const h = await client.query<HouseholdRow>(
      `insert into households (name, timezone) values ($1, $2) returning *`,
      [input.householdName, input.timezone]
    )
    const household = h.rows[0]

    const p = await client.query<PersonRow>(
      `insert into persons (household_id, name, member_type, is_admin, avatar_emoji, color_hex)
       values ($1, $2, 'adult', true, $3, $4) returning *`,
      [household.id, input.person.name, input.person.avatarEmoji, input.person.colorHex]
    )
    const person = p.rows[0]

    await client.query(`update households set owner_person_id = $1 where id = $2`, [
      person.id,
      household.id,
    ])
    household.owner_person_id = person.id

    await client.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary)
       values ($1, $2, $3, $4, $5, $6, true)`,
      [household.id, person.id, input.provider, input.sub, input.email, input.emailVerified]
    )

    if (input.credential) {
      await client.query(
        `insert into credentials (id, household_id, person_id, email, password_hash)
         values ($1, $2, $3, $4, $5)`,
        [input.sub, household.id, person.id, input.credential.email, input.credential.passwordHash]
      )
    }

    await client.query('commit')
    return { household, person }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// snake_case rows → clean camelCase API shapes.
export function presentHousehold(h: HouseholdRow) {
  return {
    id: h.id,
    name: h.name,
    timezone: h.timezone,
    weekStart: h.week_start,
    location: h.location ?? null,
    ownerPersonId: h.owner_person_id,
    settings: h.settings,
    createdAt: h.created_at,
  }
}

export function presentPerson(p: PersonRow) {
  return {
    id: p.id,
    householdId: p.household_id,
    name: p.name,
    memberType: p.member_type,
    isAdmin: p.is_admin,
    avatarType: p.avatar_type,
    avatarEmoji: p.avatar_emoji,
    avatarUrl: p.avatar_url ?? null,
    colorHex: p.color_hex,
    paletteSlot: p.palette_slot ?? null,
    birthday: p.birthday ?? null,
    dietaryNotes: p.dietary_notes ?? null,
    rewardStyle: p.reward_style ?? 'stars',
    showOnKiosk: p.show_on_kiosk ?? true,
  }
}
