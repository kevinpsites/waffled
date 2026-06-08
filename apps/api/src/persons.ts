// Members (persons) CRUD, always scoped to the caller's household.
import createAPI, { type Request } from 'lambda-api'
import { query } from './db'
import { requireTenant, presentPerson, type PersonRow } from './households'

type Api = ReturnType<typeof createAPI>

export async function listPersons(householdId: string): Promise<PersonRow[]> {
  const { rows } = await query<PersonRow>(
    `select * from persons
       where household_id = $1 and deleted_at is null
       order by sort_order, created_at`,
    [householdId]
  )
  return rows
}

export function registerPersonRoutes(api: Api): void {
  // List everyone in the household (any member may read).
  api.get('/api/persons', async (req: Request) => {
    const tenant = await requireTenant(req)
    const persons = await listPersons(tenant.householdId)
    return { persons: persons.map(presentPerson) }
  })
}
