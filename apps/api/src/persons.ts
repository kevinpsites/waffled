// Members (persons) CRUD, always scoped to the caller's household.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from './db'
import { requireTenant, requireAdmin, presentPerson, type PersonRow } from './households'

type Api = ReturnType<typeof createAPI>

const MEMBER_TYPES = new Set(['adult', 'teen', 'kid'])

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

export function registerPersonRoutes(api: Api): void {
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
}
