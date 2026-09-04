// Identity resolution + first-login provisioning.
// The identities table maps a token's `sub` → person → household; that mapping
// (not the JWT) is the authority for which household a caller belongs to.
import type { QueryResultRow } from 'pg'
import type { Request } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { AuthError, MembershipInactiveError, type Principal } from '../../platform/auth'
import { config } from '../../platform/config'
import { normalizeHouseholdTimezone } from '../../platform/access-expiry'
import { seedDefaultRecipe } from '../meals/seed-default-recipe'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Tenant {
  sub: string
  personId: string
  householdId: string
  isAdmin: boolean
  memberType: string // adult | caregiver | guest | teen | kid
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
  allergens: string[] | null
  reward_style: string
  show_on_kiosk: boolean
  access_ends_on: string | null
  access_expires_at: Date | null
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
  if (typeof claim === 'string' && UUID_RE.test(claim) && UUID_RE.test(principal.sub)) {
    const { rows } = await query<{ person_id: string; is_admin: boolean; member_type: string }>(
      `select p.id as person_id, p.is_admin, p.member_type
         from persons p
         join accounts a on a.id = p.account_id and a.deleted_at is null
        where p.account_id = $1 and p.household_id = $2 and p.deleted_at is null
          and (p.access_expires_at is null or p.access_expires_at > now())`,
      [principal.sub, claim]
    )
    const r = rows[0]
    return r
      ? { sub: principal.sub, personId: r.person_id, householdId: claim, isAdmin: r.is_admin, memberType: r.member_type }
      : null
  }
  return findTenantBySub(principal.sub)
}

export interface InactiveMembership {
  /// Present for account-backed sessions. Only a still-live account may use this
  /// recovery identity to switch directly to another active household.
  accountId: string | null
  accountActive: boolean
}

// Classify a missing active tenant without weakening `resolveTenant`: a historical
// membership/identity proves this JWT belonged to a real household session whose
// access has since ended. A subject or household claim with no such history remains
// the existing unprovisioned/unknown case.
export async function resolveInactiveMembership(principal: Principal): Promise<InactiveMembership | null> {
  const claim = principal.claims?.[config.auth.householdClaim]
  if (typeof claim === 'string' && UUID_RE.test(claim) && UUID_RE.test(principal.sub)) {
    const { rows } = await query<{ account_id: string; account_active: boolean }>(
      `select a.id as account_id, (a.deleted_at is null) as account_active
         from accounts a
        where a.id = $1
          and exists (
            select 1
              from persons p
             where p.household_id = $2
               and (
                 p.account_id = a.id
                 or exists (
                   select 1 from identities i
                    where i.person_id = p.id and i.account_id = a.id
                 )
               )
          )
          and not exists (
            select 1
              from persons active_p
              join accounts active_a
                on active_a.id = active_p.account_id and active_a.deleted_at is null
             where active_p.account_id = a.id
               and active_p.household_id = $2
               and active_p.deleted_at is null
               and (active_p.access_expires_at is null or active_p.access_expires_at > now())
          )
        limit 1`,
      [principal.sub, claim]
    )
    const row = rows[0]
    return row ? { accountId: row.account_id, accountActive: row.account_active } : null
  }

  // Legacy/profile sessions have no household claim. Keep deleted identities and
  // persons in this lookup deliberately: their existence is the evidence that the
  // otherwise-unresolved subject is revoked/expired rather than never provisioned.
  const { rows } = await query<{ account_id: string | null; account_active: boolean }>(
    `select coalesce(p.account_id, i.account_id) as account_id,
            (a.id is not null and a.deleted_at is null) as account_active
       from identities i
       join persons p on p.id = i.person_id
      left join accounts a on a.id = coalesce(p.account_id, i.account_id)
      where i.auth0_user_id = $1
        and (
          i.deleted_at is not null
          or p.deleted_at is not null
          or (p.access_expires_at is not null and p.access_expires_at <= now())
        )
      limit 1`,
    [principal.sub]
  )
  const row = rows[0]
  return row ? { accountId: row.account_id, accountActive: row.account_active } : null
}

type TenantResolver = (principal: Principal) => Promise<Tenant | null>

// The guest-write gate and the route guard both need the same tenant. Cache the
// in-flight lookup on the request object (via a WeakMap) so a mutation issues one
// database query, including when two consumers ask concurrently. A resolved null
// is cached too; otherwise an unprovisioned caller would still be queried twice.
const requestTenantCache = new WeakMap<Request, Promise<Tenant | null>>()
const requestInactiveMembershipCache = new WeakMap<Request, Promise<InactiveMembership | null>>()

export function resolveRequestTenant(
  req: Request,
  resolver: TenantResolver = resolveTenant
): Promise<Tenant | null> {
  const fromKey = (req as Request & { apiKeyTenant?: Tenant }).apiKeyTenant
  if (fromKey) return Promise.resolve(fromKey)

  const cached = requestTenantCache.get(req)
  if (cached) return cached

  const pending = req.principal ? resolver(req.principal) : Promise.resolve(null)
  requestTenantCache.set(req, pending)
  return pending
}

export function resolveRequestInactiveMembership(req: Request): Promise<InactiveMembership | null> {
  if ((req as Request & { apiKeyTenant?: Tenant }).apiKeyTenant || !req.principal) {
    return Promise.resolve(null)
  }
  const cached = requestInactiveMembershipCache.get(req)
  if (cached) return cached
  const pending = resolveInactiveMembership(req.principal)
  requestInactiveMembershipCache.set(req, pending)
  return pending
}

// Resolve the caller's household, or 403 if they haven't onboarded yet. A key-
// authenticated request already resolved its owner tenant in the auth gate, so we
// return that directly (the key's owner person is the tenant).
export async function requireTenant(req: Request): Promise<Tenant> {
  const tenant = await resolveRequestTenant(req)
  if (!tenant) {
    if (await resolveRequestInactiveMembership(req)) throw new MembershipInactiveError()
    throw new AuthError('No household for this account; create one first', 403)
  }
  return tenant
}

// Gate mutations on admin rights (owner + other admins; teens/kids never).
export function requireAdmin(tenant: Tenant): void {
  if (!tenant.isAdmin) throw new AuthError('Admin privileges required', 403)
}

// Installation-wide settings must not be writable by every household admin.
// Ownership is stored against the global account so the same human keeps operator
// access after switching households. The host-level admin CLI is the recovery and
// transfer path if that account is ever retired.
export async function requireInstallationOwner(tenant: Tenant): Promise<void> {
  const { rows } = await query<{ allowed: boolean }>(
    `select (
       current_person.account_id is not null
       and current_person.account_id = cfg.installation_owner_account_id
     ) as allowed
       from persons current_person
       cross join auth_config cfg
      where current_person.id = $1`,
    [tenant.personId]
  )
  if (rows[0]?.allowed !== true) {
    throw new AuthError('Installation owner privileges required', 403)
  }
}

export async function findTenantBySub(sub: string): Promise<Tenant | null> {
  const { rows } = await query<{ person_id: string; household_id: string; is_admin: boolean; member_type: string }>(
    `select i.person_id, p.household_id, p.is_admin, p.member_type
       from identities i
      join persons p on p.id = i.person_id and p.deleted_at is null
      where i.auth0_user_id = $1 and i.deleted_at is null
        and (p.access_expires_at is null or p.access_expires_at > now())`,
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
        and (p.access_expires_at is null or p.access_expires_at > now())
     limit 1`,
    [email]
  )
  const r = rows[0]
  return r ? { personId: r.person_id, householdId: r.household_id } : null
}

// Resolve the global account already bound to an OIDC subject even when the
// subject's current household membership has expired. The stable provider
// subject remains authoritative if the IdP email later changes.
export async function findAccountByIdentitySubject(
  subject: string
): Promise<{ id: string; email: string } | null> {
  const { rows } = await query<{ id: string; email: string }>(
    `select a.id, a.email
       from identities i
       join persons p on p.id = i.person_id
       join accounts a on a.id = coalesce(i.account_id, p.account_id) and a.deleted_at is null
      where i.auth0_user_id = $1 and i.deleted_at is null
      limit 1`,
    [subject]
  )
  return rows[0] ?? null
}

// Link an auth identity (e.g. OIDC) to an existing person, so subsequent logins
// resolve straight through findTenantBySub. A returning provider subject may move
// to another active membership after temporary access expires; upsert rebinds that
// same global identity without creating a duplicate. is_primary stays false.
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
     values ($1, $2, $3, $4, $5, $6, false, $7)
     on conflict (auth0_user_id) do update set
       household_id = excluded.household_id,
       person_id = excluded.person_id,
       provider = excluded.provider,
       email = excluded.email,
       email_verified = excluded.email_verified,
       account_id = excluded.account_id,
       deleted_at = null`,
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
  // Keep invalid text out even when this service is called outside the HTTP setup
  // route (seed/import tooling uses the same boundary).
  const timezone = normalizeHouseholdTimezone(input.timezone)
  const client = await getPool().connect()
  try {
    await client.query('begin')

    // Brand-new household from the first-run wizard → arm the post-setup "Getting
    // started" onboarding (server-authoritative, in settings.onboarding so it's
    // shared across the admin's devices, not stuck in one browser's localStorage).
    const h = await client.query<HouseholdRow>(
      `insert into households (name, timezone, settings)
       values ($1, $2, '{"onboarding":{"status":"active"}}'::jsonb) returning *`,
      [input.householdName, timezone]
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

    if (accountId) {
      await client.query(
        `update auth_config
            set installation_owner_account_id = coalesce(installation_owner_account_id, $1),
                updated_at = now()
          where id = true`,
        [accountId]
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
  const timezone = normalizeHouseholdTimezone(input.timezone)
  const client = await getPool().connect()
  try {
    await client.query('begin')

    const h = await client.query<HouseholdRow>(
      `insert into households (name, timezone) values ($1, $2) returning *`,
      [input.householdName, timezone]
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

    // Pre-seed the delightful default "Waffles" recipe (Easter egg + canonical
    // example, incl. a timer step). Atomic with household creation — same tx.
    await seedDefaultRecipe(client, household.id, person.id)

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
    allergens: p.allergens ?? [],
    rewardStyle: p.reward_style ?? 'stars',
    showOnKiosk: p.show_on_kiosk ?? true,
    accessEndsOn: p.access_ends_on ?? null,
    accessExpiresAt: p.access_expires_at ?? null,
  }
}
