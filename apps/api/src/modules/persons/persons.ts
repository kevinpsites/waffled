// Members (persons) CRUD, always scoped to the caller's household.
import createAPI, { type Request, type Response } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { presentPerson, presentHousehold, type PersonRow, type HouseholdRow } from '../households/households'
import { tenantRoute, adminRoute } from '../../platform/route-guards'
import { MODULES, MODULE_KEYS } from '../../platform/modules'
import { cleanAllergens } from '../../platform/allergens'
import {
  AccessEndDateError,
  canonicalAccessWindow,
  normalizeHouseholdTimezone,
} from '../../platform/access-expiry'

type Api = ReturnType<typeof createAPI>

const MEMBER_TYPES = new Set(['adult', 'caregiver', 'guest', 'teen', 'kid'])
const TEMPORARY_MEMBER_TYPES = new Set(['caregiver', 'guest'])
const WEEK_STARTS = new Set(['sunday', 'monday'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// camelCase API field → persons column. Anything not here can't be patched.
const UPDATABLE: Record<string, string> = {
  name: 'name',
  memberType: 'member_type',
  isAdmin: 'is_admin',
  avatarType: 'avatar_type',
  avatarEmoji: 'avatar_emoji',
  avatarUrl: 'avatar_url',
  colorHex: 'color_hex',
  paletteSlot: 'palette_slot',
  birthday: 'birthday',
  dietaryNotes: 'dietary_notes',
  allergens: 'allergens',
  rewardStyle: 'reward_style',
  showOnKiosk: 'show_on_kiosk',
  accessEndsOn: 'access_ends_on',
  accessExpiresAt: 'access_expires_at',
  sortOrder: 'sort_order',
}

export async function listPersons(householdId: string): Promise<PersonRow[]> {
  const { rows } = await query<PersonRow>(
    `select * from persons
       where household_id = $1 and deleted_at is null
       order by sort_order, created_at`,
    [householdId]
  )
  return rows
}

export interface CreatePersonInput {
  name: string
  memberType: string
  avatarEmoji?: string | null
  colorHex?: string | null
  birthday?: string | null
  isAdmin?: boolean
  rewardStyle?: string
  sortOrder?: number
  showOnKiosk?: boolean
  accessEndsOn?: string | null
  accessExpiresAt?: string | null
}

type PersonRequestBody = Partial<CreatePersonInput> & { accessEndsOn?: unknown }

export async function createPerson(
  householdId: string,
  input: CreatePersonInput
): Promise<PersonRow> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Validation and persistence must observe one timezone. A concurrent timezone
    // patch either commits before this lock (and is validated here) or waits until
    // the new person has been canonicalized by the database trigger.
    const household = await client.query<{ timezone: string }>(
      `select timezone from households where id = $1 and deleted_at is null for share`,
      [householdId]
    )
    if (!household.rows[0]) throw new Error('household not found')
    const accessWindow = canonicalAccessWindow(input, household.rows[0].timezone)
    const accessEndsOn = accessWindow?.accessEndsOn ?? null

    const { rows } = await client.query<PersonRow>(
      `insert into persons
         (household_id, name, member_type, is_admin, avatar_emoji, color_hex, birthday,
          reward_style, sort_order, show_on_kiosk, access_ends_on, access_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7,
               coalesce($8,'stars'), coalesce($9,0), $10, $11, null)
       returning *`,
      [
        householdId,
        input.name,
        input.memberType,
        input.isAdmin ?? false,
        input.avatarEmoji ?? null,
        input.colorHex ?? null,
        input.birthday ?? null,
        input.rewardStyle ?? null,
        input.sortOrder ?? null,
        input.showOnKiosk ?? !TEMPORARY_MEMBER_TYPES.has(input.memberType),
        accessEndsOn,
      ]
    )
    const person = rows[0]
    if (person.access_expires_at && person.access_expires_at.getTime() <= Date.now()) {
      throw new AccessEndDateError('access expiration must remain in the future')
    }
    await client.query('commit')
    return person
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function getPerson(householdId: string, id: string): Promise<PersonRow | null> {
  const { rows } = await query<PersonRow>(
    `select * from persons where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

async function ownerPersonId(householdId: string): Promise<string | null> {
  const { rows } = await query<{ owner_person_id: string | null }>(
    `select owner_person_id from households where id=$1`,
    [householdId]
  )
  return rows[0]?.owner_person_id ?? null
}

// Patch is a whitelisted, household-scoped update. Returns null if no such
// (live) person in this household. Caller validates the patch first.
export async function updatePerson(
  householdId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<PersonRow | null> {
  const changesAccessWindow =
    patch.accessEndsOn !== undefined || patch.accessExpiresAt !== undefined

  if (changesAccessWindow) {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const household = await client.query<{ timezone: string }>(
        `select timezone from households where id = $1 and deleted_at is null for share`,
        [householdId]
      )
      if (!household.rows[0]) {
        await client.query('rollback')
        return null
      }

      const normalized = { ...patch }
      const accessWindow = canonicalAccessWindow(normalized, household.rows[0].timezone)
      delete normalized.accessEndsOn
      delete normalized.accessExpiresAt
      if (accessWindow) normalized.accessEndsOn = accessWindow.accessEndsOn

      const { sets, values } = personUpdateParts(normalized)
      values.push(householdId, id)
      const { rows } = await client.query<PersonRow>(
        `update persons set ${sets.join(', ')}
           where household_id = $${values.length - 1} and id = $${values.length} and deleted_at is null
         returning *`,
        values
      )
      const person = rows[0] ?? null
      if (person?.access_expires_at && person.access_expires_at.getTime() <= Date.now()) {
        throw new AccessEndDateError('access expiration must remain in the future')
      }
      await client.query('commit')
      return person
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  const { sets, values } = personUpdateParts(patch)
  values.push(householdId, id)
  const { rows } = await query<PersonRow>(
    `update persons set ${sets.join(', ')}
       where household_id = $${values.length - 1} and id = $${values.length} and deleted_at is null
     returning *`,
    values
  )
  return rows[0] ?? null
}

function personUpdateParts(patch: Record<string, unknown>): { sets: string[]; values: unknown[] } {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${column} = $${values.length + 1}`)
      values.push(patch[field])
    }
  }
  return { sets, values }
}

// Pin (or clear) the reward a person is "saving toward". Household-scoped, not
// admin-gated — a kid chooses their own target from the parent-curated shop. A
// non-null rewardId must point at a live reward in this household.
export async function setSavingToward(
  householdId: string,
  personId: string,
  rewardId: string | null
): Promise<PersonRow | null> {
  if (rewardId) {
    const { rowCount } = await query(
      `select 1 from rewards where household_id=$1 and id=$2 and deleted_at is null`,
      [householdId, rewardId]
    )
    if (!rowCount) return null
  }
  const { rows } = await query<PersonRow>(
    `update persons set saving_toward_reward_id = $1
       where household_id = $2 and id = $3 and deleted_at is null
       returning *`,
    [rewardId, householdId, personId]
  )
  return rows[0] ?? null
}

export type DeleteResult = 'deleted' | 'not_found' | 'is_owner'

// Soft-delete a member. The household owner can't be removed.
export async function softDeletePerson(householdId: string, id: string): Promise<DeleteResult> {
  const owner = await query<{ owner_person_id: string | null }>(
    `select owner_person_id from households where id = $1`,
    [householdId]
  )
  if (owner.rows[0]?.owner_person_id === id) return 'is_owner'

  const { rowCount } = await query(
    `update persons set deleted_at = now()
       where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rowCount ? 'deleted' : 'not_found'
}

// Household + members, enriched for the Settings screen: each member carries a
// derived `hasLogin` (has an identity) and `isOwner` flag.
export async function householdSettings(householdId: string) {
  const h = (await query<HouseholdRow>(`select * from households where id = $1`, [householdId])).rows[0]
  const { rows } = await query<PersonRow & { has_login: boolean; login_email: string | null; has_password: boolean; has_pin: boolean }>(
    `select p.*,
            exists(select 1 from identities i where i.person_id = p.id and i.deleted_at is null) as has_login,
            (select a.email from accounts a where a.id = p.account_id and a.deleted_at is null) as login_email,
            exists(select 1 from accounts a where a.id = p.account_id and a.deleted_at is null and a.password_hash is not null) as has_password,
            (p.pin_hash is not null) as has_pin
       from persons p
      where p.household_id = $1 and p.deleted_at is null
      order by p.sort_order, p.created_at`,
    [householdId]
  )
  const members = rows.map((r) => ({
    ...presentPerson(r),
    hasLogin: r.has_login,
    loginEmail: r.login_email,
    hasPassword: r.has_password,
    hasPin: r.has_pin,
    isOwner: r.id === h.owner_person_id,
  }))
  return { household: presentHousehold(h), members }
}

const HOUSEHOLD_COLUMNS: Record<string, string> = { name: 'name', timezone: 'timezone', weekStart: 'week_start', location: 'location' }

export async function updateHousehold(householdId: string, patch: Record<string, unknown>): Promise<HouseholdRow | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [field, column] of Object.entries(HOUSEHOLD_COLUMNS)) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${column} = $${i++}`)
      values.push(field === 'timezone' ? normalizeHouseholdTimezone(patch[field]) : patch[field])
    }
  }
  if (sets.length === 0) {
    const { rows } = await query<HouseholdRow>(`select * from households where id = $1`, [householdId])
    return rows[0] ?? null
  }
  values.push(householdId)
  const { rows } = await query<HouseholdRow>(`update households set ${sets.join(', ')} where id = $${i} returning *`, values)
  return rows[0] ?? null
}

// Merge the post-setup "Getting started" onboarding state into settings.onboarding
// (status: active|dismissed, opened: has the overlay auto-opened once). jsonb merge
// so we never clobber sibling settings keys (rewards/chores/etc.).
export async function updateOnboarding(
  householdId: string,
  patch: { status?: string; opened?: boolean }
): Promise<HouseholdRow | null> {
  const merge: Record<string, unknown> = {}
  if (patch.status !== undefined) merge.status = patch.status
  if (patch.opened !== undefined) merge.opened = patch.opened
  if (Object.keys(merge).length === 0) {
    const { rows } = await query<HouseholdRow>(`select * from households where id = $1`, [householdId])
    return rows[0] ?? null
  }
  const { rows } = await query<HouseholdRow>(
    `update households
        set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb),
          '{onboarding}',
          coalesce(settings->'onboarding', '{}'::jsonb) || $2::jsonb
        )
      where id = $1
      returning *`,
    [householdId, JSON.stringify(merge)]
  )
  return rows[0] ?? null
}

// Merge optional-module enable flags into settings.modules (jsonb merge so sibling
// settings keys are preserved). Only catalog keys with boolean values reach here.
export async function updateModules(
  householdId: string,
  patch: Record<string, boolean>
): Promise<HouseholdRow | null> {
  if (Object.keys(patch).length === 0) {
    const { rows } = await query<HouseholdRow>(`select * from households where id = $1`, [householdId])
    return rows[0] ?? null
  }
  const { rows } = await query<HouseholdRow>(
    `update households
        set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb),
          '{modules}',
          coalesce(settings->'modules', '{}'::jsonb) || $2::jsonb
        )
      where id = $1
      returning *`,
    [householdId, JSON.stringify(patch)]
  )
  return rows[0] ?? null
}

// Merge the calendar's display preferences into settings.display (jsonb merge,
// same as modules above, so sibling settings keys survive).
//
// settings.display is SHARED with the kiosk display wrapper, which owns the
// screensaver keys (see modules/kiosk/kiosk.ts DISPLAY_DEFAULTS). The contract
// both sides keep: merge your write, and read/serve only your own keys.
export async function updateDisplay(
  householdId: string,
  patch: Record<string, string>
): Promise<HouseholdRow | null> {
  const { rows } = await query<HouseholdRow>(
    `update households
        set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb),
          '{display}',
          coalesce(settings->'display', '{}'::jsonb) || $2::jsonb
        )
      where id = $1
      returning *`,
    [householdId, JSON.stringify(patch)]
  )
  return rows[0] ?? null
}

// How event chips render across the calendar views: 'solid' (full-color blocks,
// the default) or 'tinted' (the soft wash).
const EVENT_STYLES = new Set(['solid', 'tinted'])
// The calendar's share of settings.display (the kiosk owns the rest — see updateDisplay).
const CALENDAR_DISPLAY_KEYS = ['eventStyle', 'familyColorHex'] as const
// Person + family colors must be a full #RRGGBB hex — they go straight into CSS
// custom properties on every calendar view. (Shared with account.ts, app.ts and
// auth.ts: every path that writes a color validates it.)
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * Best-effort repair of a color we already stored, for values that predate this
 * validation: `#abc` → `#aabbcc`. Returns null when there's nothing to recover
 * (a palette token, a CSS color name), in which case the value is kept as-is
 * rather than blocking the save. Deliberately NOT used to loosen new input.
 */
export function migrateColorHex(value: unknown): string | null {
  const v = String(value ?? '').trim()
  if (HEX_COLOR.test(v)) return v
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v)
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null
}

/**
 * Resolve a colorHex a client sent for a person who already has one. A full
 * #RRGGBB passes through; anything else is only accepted when it's the value we
 * already hold — the member editor and the profile card resend colorHex on every
 * save, so rejecting a legacy value would lock that member out of being saved at
 * all. Such a value is migrated to #RRGGBB when it can be, and kept otherwise.
 * Returns null when the value is genuinely new bad input (→ 400).
 */
export function resolveColorHex(value: unknown, stored: string | null): string | null {
  const v = String(value ?? '')
  if (HEX_COLOR.test(v)) return v
  if (stored === null || v !== stored) return null
  return migrateColorHex(v) ?? stored
}

export function registerPersonRoutes(api: Api): void {
  // Household settings: the household + its members (with login/owner flags).
  api.get('/api/household/settings', tenantRoute((tenant) => householdSettings(tenant.householdId)))

  // Edit household basics (admins only): name / timezone / week start.
  api.patch('/api/household', adminRoute(async (tenant, req: Request, res: Response) => {
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (patch.weekStart !== undefined && !WEEK_STARTS.has(String(patch.weekStart))) {
      return res.status(400).json({ error: 'BadRequest', message: 'weekStart must be sunday|monday' })
    }
    if (!Object.keys(HOUSEHOLD_COLUMNS).some((f) => f in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }
    let h: HouseholdRow | null
    try {
      h = await updateHousehold(tenant.householdId, patch)
    } catch (error) {
      if (!(error instanceof AccessEndDateError)) throw error
      return res.status(400).json({ error: 'BadRequest', message: error.message })
    }
    if (!h) return res.status(404).json({ error: 'NotFound', message: 'household not found' })
    return { household: presentHousehold(h) }
  }))

  // Advance the "Getting started" onboarding (admins only): mark the overlay opened
  // or dismiss the checklist. Server-side so it follows the household, not a device.
  api.patch('/api/household/onboarding', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { status?: unknown; opened?: unknown }
    const patch: { status?: string; opened?: boolean } = {}
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'dismissed') {
        return res.status(400).json({ error: 'BadRequest', message: 'status must be active|dismissed' })
      }
      patch.status = body.status
    }
    if (body.opened !== undefined) patch.opened = !!body.opened
    if (patch.status === undefined && patch.opened === undefined) {
      return res.status(400).json({ error: 'BadRequest', message: 'provide status and/or opened' })
    }
    const h = await updateOnboarding(tenant.householdId, patch)
    if (!h) return res.status(404).json({ error: 'NotFound', message: 'household not found' })
    return { onboarding: (h.settings as { onboarding?: unknown })?.onboarding ?? null }
  }))

  // Enable/disable optional modules (admins only). Stored in settings.modules; only
  // catalog keys with boolean values are accepted (planned modules are rejected).
  api.patch('/api/household/modules', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(body)) {
      if (!MODULE_KEYS.has(k) || typeof v !== 'boolean') continue
      const def = MODULES.find((m) => m.key === k)
      if (def?.status !== 'available') continue // can't toggle a not-yet-built module
      patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'no valid module flags provided' })
    }
    const h = await updateModules(tenant.householdId, patch)
    if (!h) return res.status(404).json({ error: 'NotFound', message: 'household not found' })
    return { modules: (h.settings as { modules?: unknown })?.modules ?? {} }
  }))

  // Display preferences (admins only). Stored in settings.display: eventStyle (how
  // event chips are colored across the calendar views) and familyColorHex (the color
  // for events that involve the whole family).
  api.patch('/api/household/display', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, string> = {}
    if (body.eventStyle !== undefined) {
      if (typeof body.eventStyle !== 'string' || !EVENT_STYLES.has(body.eventStyle)) {
        return res.status(400).json({ error: 'BadRequest', message: 'eventStyle must be solid|tinted' })
      }
      patch.eventStyle = body.eventStyle
    }
    if (body.familyColorHex !== undefined) {
      if (typeof body.familyColorHex !== 'string' || !HEX_COLOR.test(body.familyColorHex)) {
        return res.status(400).json({ error: 'BadRequest', message: 'familyColorHex must be a #RRGGBB hex color' })
      }
      patch.familyColorHex = body.familyColorHex
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'no valid display settings provided' })
    }
    const h = await updateDisplay(tenant.householdId, patch)
    if (!h) return res.status(404).json({ error: 'NotFound', message: 'household not found' })
    // Serve only the calendar's own keys — the kiosk's screensaver settings share
    // this object and aren't ours to hand back.
    const stored = ((h.settings as { display?: Record<string, unknown> })?.display ?? {}) as Record<string, unknown>
    const display: Record<string, unknown> = {}
    for (const k of CALENDAR_DISPLAY_KEYS) if (stored[k] !== undefined) display[k] = stored[k]
    return { display }
  }))

  // List everyone in the household (any member may read).
  api.get('/api/persons', tenantRoute(async (tenant) => {
    const persons = await listPersons(tenant.householdId)
    return { persons: persons.map(presentPerson) }
  }))

  // Add a member (admins only).
  api.post('/api/persons', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = { ...((req.body ?? {}) as PersonRequestBody) } as PersonRequestBody
    if (!body.name || !body.memberType || !MEMBER_TYPES.has(body.memberType)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'name and a valid memberType are required',
      })
    }
    if (body.colorHex != null && !HEX_COLOR.test(String(body.colorHex))) {
      return res.status(400).json({ error: 'BadRequest', message: 'colorHex must be a #RRGGBB hex color' })
    }
    if (body.isAdmin !== undefined && typeof body.isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'isAdmin must be a boolean' })
    }
    if (body.showOnKiosk !== undefined && typeof body.showOnKiosk !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'showOnKiosk must be a boolean' })
    }
    if (body.isAdmin && body.memberType !== 'adult') {
      return res.status(400).json({ error: 'BadRequest', message: 'only an adult role can be an admin' })
    }
    if (body.accessEndsOn !== undefined && body.accessExpiresAt !== undefined) {
      return res.status(400).json({ error: 'BadRequest', message: 'send accessEndsOn instead of accessExpiresAt, not both' })
    }
    if (!TEMPORARY_MEMBER_TYPES.has(body.memberType) &&
        (body.accessEndsOn != null || body.accessExpiresAt != null)) {
      return res.status(400).json({ error: 'BadRequest', message: 'access expiration is only available for caregiver and guest roles' })
    }
    let person: PersonRow
    try {
      person = await createPerson(tenant.householdId, body as CreatePersonInput)
    } catch (error) {
      if (!(error instanceof AccessEndDateError)) throw error
      return res.status(400).json({ error: 'BadRequest', message: error.message })
    }
    return res.status(201).json({ person: presentPerson(person) })
  }))

  // Read one member by id (any member may read; 404 if not in this household).
  api.get('/api/persons/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const person = await getPerson(tenant.householdId, id)
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return { person: presentPerson(person) }
  }))

  // Update a member (admins only).
  api.patch('/api/persons/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })

    const patch = { ...((req.body ?? {}) as Record<string, unknown>) }
    if (patch.memberType !== undefined && !MEMBER_TYPES.has(String(patch.memberType))) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid memberType' })
    }
    // null clears the color; anything else must be a full #RRGGBB hex — except a
    // legacy value this member already holds, which is accepted (and migrated
    // where possible) so a pre-validation color can't block every future save.
    if (patch.colorHex != null && !HEX_COLOR.test(String(patch.colorHex))) {
      const existing = await getPerson(tenant.householdId, id)
      const resolved = resolveColorHex(patch.colorHex, existing?.color_hex ?? null)
      if (!resolved) {
        return res.status(400).json({ error: 'BadRequest', message: 'colorHex must be a #RRGGBB hex color' })
      }
      patch.colorHex = resolved
    }
    if (patch.isAdmin !== undefined && typeof patch.isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'isAdmin must be a boolean' })
    }
    if (patch.showOnKiosk !== undefined && typeof patch.showOnKiosk !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'showOnKiosk must be a boolean' })
    }
    if ('allergens' in patch) patch.allergens = cleanAllergens(patch.allergens)
    if (patch.accessEndsOn !== undefined && patch.accessExpiresAt !== undefined) {
      return res.status(400).json({ error: 'BadRequest', message: 'send accessEndsOn instead of accessExpiresAt, not both' })
    }
    if (!Object.keys(UPDATABLE).some((field) => field in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }

    const current = await getPerson(tenant.householdId, id)
    if (!current) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const nextType = String(patch.memberType ?? current.member_type)
    const nextAdmin = typeof patch.isAdmin === 'boolean' ? patch.isAdmin : current.is_admin
    if (id === await ownerPersonId(tenant.householdId) && (nextType !== 'adult' || nextAdmin === false)) {
      return res.status(409).json({ error: 'Conflict', message: 'the household owner must remain an adult admin' })
    }
    if (nextAdmin && nextType !== 'adult') {
      return res.status(400).json({ error: 'BadRequest', message: 'only an adult role can be an admin' })
    }
    if ((patch.accessEndsOn != null || patch.accessExpiresAt != null) && !TEMPORARY_MEMBER_TYPES.has(nextType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'access expiration is only available for caregiver and guest roles' })
    }
    if (!TEMPORARY_MEMBER_TYPES.has(nextType)) {
      patch.accessEndsOn = null
      delete patch.accessExpiresAt
    }

    let person: PersonRow | null
    try {
      person = await updatePerson(tenant.householdId, id, patch)
    } catch (error) {
      if (!(error instanceof AccessEndDateError)) throw error
      return res.status(400).json({ error: 'BadRequest', message: error.message })
    }
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return { person: presentPerson(person) }
  }))

  // Pin what a person is "saving toward" (any household member — kids set their
  // own). Body: { rewardId: string | null }. null clears it.
  api.post('/api/persons/:id/saving-toward', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const rewardId = (req.body as { rewardId?: unknown })?.rewardId ?? null
    if (rewardId !== null && (typeof rewardId !== 'string' || !UUID_RE.test(rewardId))) {
      return res.status(400).json({ error: 'BadRequest', message: 'rewardId must be a uuid or null' })
    }
    const person = await setSavingToward(tenant.householdId, id, rewardId as string | null)
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person or reward not found' })
    return { person: presentPerson(person) }
  }))

  // Soft-delete a member (admins only; the owner is protected).
  api.delete('/api/persons/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })

    const result = await softDeletePerson(tenant.householdId, id)
    if (result === 'is_owner') {
      return res.status(409).json({ error: 'Conflict', message: 'cannot remove the household owner' })
    }
    if (result === 'not_found') {
      return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    }
    return res.status(204).send('')
  }))
}
