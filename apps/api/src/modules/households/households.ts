// Identity resolution + first-login provisioning.
// The identities table maps a token's `sub` → person → household; that mapping
// (not the JWT) is the authority for which household a caller belongs to.
import type { QueryResultRow } from 'pg'
import type { Request } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { AuthError, type Principal } from '../../platform/auth'
import { config } from '../../platform/config'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Tenant {
  sub: string
  personId: string
  householdId: string
  isAdmin: boolean
  memberType: string // adult | teen | kid — drives the capability matrix (see platform/permissions)
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

// Resolve the caller's active membership from their token, or null if none.
// An account-scoped token carries the active household in config.auth.householdClaim
// and its `sub` is the account id; otherwise we fall back to the legacy
// sub → identity → person → household path (covers pre-P2 tokens, kiosk, device).
export async function resolveTenant(principal: Principal): Promise<Tenant | null> {
  const claim = principal.claims?.[config.auth.householdClaim]
  if (typeof claim === 'string' && claim && UUID_RE.test(principal.sub)) {
    const { rows } = await query<{ person_id: string; is_admin: boolean; member_type: string }>(
      `select p.id as person_id, p.is_admin, p.member_type
         from persons p
         join accounts a on a.id = p.account_id and a.deleted_at is null
        where p.account_id = $1 and p.household_id = $2 and p.deleted_at is null`,
      [principal.sub, claim]
    )
    const r = rows[0]
    return r
      ? { sub: principal.sub, personId: r.person_id, householdId: claim, isAdmin: r.is_admin, memberType: r.member_type }
      : null
  }
  return findTenantBySub(principal.sub)
}

// Resolve the caller's household, or 403 if they haven't onboarded yet. A key-
// authenticated request already resolved its owner tenant in the auth gate, so we
// return that directly (the key's owner person is the tenant).
export async function requireTenant(req: Request): Promise<Tenant> {
  const fromKey = (req as Request & { apiKeyTenant?: Tenant }).apiKeyTenant
  if (fromKey) return fromKey
  const tenant = await resolveTenant(req.principal!)
  if (!tenant) throw new AuthError('No household for this account; create one first', 403)
  return tenant
}

// Gate mutations on admin rights (owner + other admins; teens/kids never).
export function requireAdmin(tenant: Tenant): void {
  if (!tenant.isAdmin) throw new AuthError('Admin privileges required', 403)
}

export async function findTenantBySub(sub: string): Promise<Tenant | null> {
  const { rows } = await query<{ person_id: string; household_id: string; is_admin: boolean; member_type: string }>(
    `select i.person_id, p.household_id, p.is_admin, p.member_type
       from identities i
       join persons p on p.id = i.person_id and p.deleted_at is null
      where i.auth0_user_id = $1 and i.deleted_at is null`,
    [sub]
  )
  const r = rows[0]
  return r
    ? { sub, personId: r.person_id, householdId: r.household_id, isAdmin: r.is_admin, memberType: r.member_type }
    : null
}

// Invite-gated OIDC: a first-time SSO login only succeeds if its verified email
// already belongs to a person on file (added by an admin / created at setup). The
// credentials table is retired, so we match against any identity's email — a
// password login carries the same email on its password identity, so the setup
// admin can still SSO in by their setup email. (Account-backed members are matched
// earlier via findAccountByEmail; this is the legacy email-only fallback.)
export async function findPersonByEmail(
  email: string
): Promise<{ personId: string; householdId: string } | null> {
  const { rows } = await query<{ person_id: string; household_id: string }>(
    `select i.person_id, p.household_id
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
  accountId: string | null
}): Promise<void> {
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary, account_id)
     values ($1, $2, $3, $4, $5, $6, false, $7)`,
    [input.householdId, input.personId, input.provider, input.subject, input.email, input.emailVerified, input.accountId]
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
  // Built-in password setup: seeds the account's password_hash so login (which
  // authenticates the account) can verify the password. No credentials row — the
  // legacy credentials table is retired.
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

    // Brand-new household from the first-run wizard → arm the post-setup "Getting
    // started" onboarding (server-authoritative, in settings.onboarding so it's
    // shared across the admin's devices, not stuck in one browser's localStorage).
    const h = await client.query<HouseholdRow>(
      `insert into households (name, timezone, settings)
       values ($1, $2, '{"onboarding":{"status":"active"}}'::jsonb) returning *`,
      [input.householdName, input.timezone]
    )
    const household = h.rows[0]

    // The global account (the human login, keyed by email). Only when we have an
    // email — an account is meaningless without one. Reuse an existing active
    // account for this email (so this composes with multi-household join later);
    // a select-for-update inside the txn sidesteps the partial unique index that
    // makes a plain `on conflict` unworkable.
    let accountId: string | null = null
    if (input.email) {
      const existing = await client.query<{ id: string }>(
        `select id from accounts where lower(email) = lower($1) and deleted_at is null for update`,
        [input.email]
      )
      if (existing.rows[0]) {
        accountId = existing.rows[0].id
        await client.query(`update accounts set last_household_id = $1 where id = $2`, [
          household.id,
          accountId,
        ])
      } else {
        const a = await client.query<{ id: string }>(
          `insert into accounts (email, password_hash, last_household_id)
           values ($1, $2, $3) returning id`,
          [input.email, input.credential?.passwordHash ?? null, household.id]
        )
        accountId = a.rows[0].id
      }
    }

    const p = await client.query<PersonRow>(
      `insert into persons (household_id, name, member_type, is_admin, avatar_emoji, color_hex, account_id)
       values ($1, $2, 'adult', true, $3, $4, $5) returning *`,
      [household.id, input.person.name, input.person.avatarEmoji, input.person.colorHex, accountId]
    )
    const person = p.rows[0]

    await client.query(`update households set owner_person_id = $1 where id = $2`, [
      person.id,
      household.id,
    ])
    household.owner_person_id = person.id

    await client.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary, account_id)
       values ($1, $2, $3, $4, $5, $6, true, $7)`,
      [household.id, person.id, input.provider, input.sub, input.email, input.emailVerified, accountId]
    )

    await client.query('commit')
    return { household, person }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Admin-gated additional-household creation (design §5.8, decision 4). Unlike
// provisionHousehold (first-login), the caller's account already exists, so we
// create ONLY the household + owner person and link the person to that account —
// no identity, no credential, no new account. We also leave the account's
// last_household_id untouched so the caller's current session isn't disrupted;
// they switch into the new household explicitly via /api/auth/switch.
export async function createHouseholdForAccount(
  accountId: string,
  input: {
    householdName: string
    timezone: string
    person: { name: string; avatarEmoji: string | null; colorHex: string | null }
  }
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
      `insert into persons (household_id, name, member_type, is_admin, avatar_emoji, color_hex, account_id)
       values ($1, $2, 'adult', true, $3, $4, $5) returning *`,
      [household.id, input.person.name, input.person.avatarEmoji, input.person.colorHex, accountId]
    )
    const person = p.rows[0]

    await client.query(`update households set owner_person_id = $1 where id = $2`, [
      person.id,
      household.id,
    ])
    household.owner_person_id = person.id

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
