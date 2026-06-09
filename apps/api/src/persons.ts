// Members (persons) CRUD, always scoped to the caller's household.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from './db'
import { requireTenant, requireAdmin, presentPerson, presentHousehold, type PersonRow, type HouseholdRow } from './households'

type Api = ReturnType<typeof createAPI>

const MEMBER_TYPES = new Set(['adult', 'teen', 'kid'])
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
  rewardStyle: 'reward_style',
  showOnKiosk: 'show_on_kiosk',
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
}

export async function createPerson(
  householdId: string,
  input: CreatePersonInput
): Promise<PersonRow> {
  const { rows } = await query<PersonRow>(
    `insert into persons
       (household_id, name, member_type, is_admin, avatar_emoji, color_hex, birthday, reward_style, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8,'stars'), coalesce($9,0))
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
    ]
  )
  return rows[0]
}

export async function getPerson(householdId: string, id: string): Promise<PersonRow | null> {
  const { rows } = await query<PersonRow>(
    `select * from persons where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

// Patch is a whitelisted, household-scoped update. Returns null if no such
// (live) person in this household. Caller validates the patch first.
export async function updatePerson(
  householdId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<PersonRow | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${column} = $${i++}`)
      values.push(patch[field])
    }
  }
  values.push(householdId, id)
  const { rows } = await query<PersonRow>(
    `update persons set ${sets.join(', ')}
       where household_id = $${i++} and id = $${i} and deleted_at is null
       returning *`,
    values
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
  const { rows } = await query<PersonRow & { has_login: boolean }>(
    `select p.*,
            exists(select 1 from identities i where i.person_id = p.id and i.deleted_at is null) as has_login
       from persons p
      where p.household_id = $1 and p.deleted_at is null
      order by p.sort_order, p.created_at`,
    [householdId]
  )
  const members = rows.map((r) => ({ ...presentPerson(r), hasLogin: r.has_login, isOwner: r.id === h.owner_person_id }))
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
      values.push(patch[field])
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

export function registerPersonRoutes(api: Api): void {
  // Household settings: the household + its members (with login/owner flags).
  api.get('/api/household/settings', async (req: Request) => {
    const tenant = await requireTenant(req)
    return householdSettings(tenant.householdId)
  })

  // Edit household basics (admins only): name / timezone / week start.
  api.patch('/api/household', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (patch.weekStart !== undefined && !WEEK_STARTS.has(String(patch.weekStart))) {
      return res.status(400).json({ error: 'BadRequest', message: 'weekStart must be sunday|monday' })
    }
    if (!Object.keys(HOUSEHOLD_COLUMNS).some((f) => f in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }
    const h = await updateHousehold(tenant.householdId, patch)
    if (!h) return res.status(404).json({ error: 'NotFound', message: 'household not found' })
    return { household: presentHousehold(h) }
  })

  // List everyone in the household (any member may read).
  api.get('/api/persons', async (req: Request) => {
    const tenant = await requireTenant(req)
    const persons = await listPersons(tenant.householdId)
    return { persons: persons.map(presentPerson) }
  })

  // Add a member (admins only).
  api.post('/api/persons', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as Partial<CreatePersonInput>
    if (!body.name || !body.memberType || !MEMBER_TYPES.has(body.memberType)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'name and memberType (adult|teen|kid) are required',
      })
    }
    const person = await createPerson(tenant.householdId, body as CreatePersonInput)
    return res.status(201).json({ person: presentPerson(person) })
  })

  // Read one member by id (any member may read; 404 if not in this household).
  api.get('/api/persons/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const person = await getPerson(tenant.householdId, id)
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return { person: presentPerson(person) }
  })

  // Update a member (admins only).
  api.patch('/api/persons/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })

    const patch = (req.body ?? {}) as Record<string, unknown>
    if (patch.memberType !== undefined && !MEMBER_TYPES.has(String(patch.memberType))) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid memberType' })
    }
    if (!Object.keys(UPDATABLE).some((field) => field in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }

    const person = await updatePerson(tenant.householdId, id, patch)
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return { person: presentPerson(person) }
  })

  // Soft-delete a member (admins only; the owner is protected).
  api.delete('/api/persons/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
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
  })
}
