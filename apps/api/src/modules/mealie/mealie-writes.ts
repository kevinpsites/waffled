// Mealie writes: shopping items and meal plan entries. Each clears the cache of what it changed.
import { mealieFetch, mealieNoShoppingList, MealieError } from './mealie-client'
import { cacheClear } from './mealie-cache'
import type { MealieConn } from './mealie-connection'

const CREATABLE_TYPES = ['breakfast', 'lunch', 'dinner', 'side']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const badRequest = (m: string) => new MealieError('BadRequest', m, 400)

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
}

export async function addShoppingItem(householdId: string, conn: MealieConn, text: unknown): Promise<void> {
  const note = typeof text === 'string' ? text.trim() : ''
  if (note.length < 1 || note.length > 200) throw badRequest('Item text must be 1 to 200 characters')
  if (!conn.shoppingListId) throw mealieNoShoppingList()
  await mealieFetch(conn, '/api/households/shopping/items', { method: 'POST', body: { shoppingListId: conn.shoppingListId, note } })
  cacheClear(householdId, 'shopping')
}

// Mealie's PUT needs the whole item, so read it and send it back with only `checked` changed.
export async function setShoppingItemChecked(householdId: string, conn: MealieConn, id: string, checked: unknown): Promise<void> {
  if (typeof checked !== 'boolean') throw badRequest('checked must be true or false')
  if (!id) throw badRequest('An item id is required')
  const path = `/api/households/shopping/items/${encodeURIComponent(id)}`
  const current = await mealieFetch<Record<string, unknown>>(conn, path)
  await mealieFetch(conn, path, { method: 'PUT', body: { ...current, checked } })
  cacheClear(householdId, 'shopping')
}

export interface PlanInput {
  date?: unknown
  entryType?: unknown
  recipeId?: unknown
  title?: unknown
}

export async function createPlanEntry(householdId: string, conn: MealieConn, input: PlanInput): Promise<void> {
  if (!validDate(input.date)) throw badRequest('date must be a YYYY-MM-DD date')
  if (typeof input.entryType !== 'string' || !CREATABLE_TYPES.includes(input.entryType)) {
    throw badRequest(`entryType must be one of ${CREATABLE_TYPES.join(', ')}`)
  }
  const body: Record<string, unknown> = { date: input.date, entryType: input.entryType }
  if (input.recipeId !== undefined && input.recipeId !== null && input.recipeId !== '') {
    if (typeof input.recipeId !== 'string' || !UUID_RE.test(input.recipeId)) throw badRequest('recipeId must be a uuid')
    body.recipeId = input.recipeId
  } else {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) throw badRequest('A recipeId or a title is required')
    body.title = title
  }
  await mealieFetch(conn, '/api/households/mealplans', { method: 'POST', body })
  cacheClear(householdId, 'plan')
}

export async function deletePlanEntry(householdId: string, conn: MealieConn, id: string): Promise<void> {
  if (!/^\d+$/.test(id)) throw badRequest('The entry id must be an integer')
  await mealieFetch(conn, `/api/households/mealplans/${id}`, { method: 'DELETE' })
  cacheClear(householdId, 'plan')
}
