// Per-household Mealie connection: storage, validation and the public status shape.
import { query } from '../../platform/db'
import { encryptSecret, decryptSecret, encryptionAvailable } from '../../platform/crypto'
import { cacheClear } from './mealie-cache'
import { mealieFetch, mealieNotConnected, normalizeBaseUrl, MealieError, type MealieTarget } from './mealie-client'

export interface MealieConn {
  baseUrl: string
  publicUrl: string | null
  token: string
  shoppingListId: string | null
  shoppingListName: string | null
  mealieVersion: string | null
}

interface Row {
  base_url: string
  public_url: string | null
  token_encrypted: string
  shopping_list_id: string | null
  shopping_list_name: string | null
  mealie_version: string | null
}

export async function getConnection(householdId: string): Promise<MealieConn | null> {
  const { rows } = await query<Row>('select * from mealie_connections where household_id = $1', [householdId])
  const r = rows[0]
  if (!r) return null
  return {
    baseUrl: r.base_url,
    publicUrl: r.public_url,
    token: decryptSecret(r.token_encrypted),
    shoppingListId: r.shopping_list_id,
    shoppingListName: r.shopping_list_name,
    mealieVersion: r.mealie_version,
  }
}

export async function mealieConnected(householdId: string): Promise<boolean> {
  const { rows } = await query('select 1 from mealie_connections where household_id = $1', [householdId])
  return rows.length > 0
}

export async function requireConnection(householdId: string): Promise<MealieConn> {
  const c = await getConnection(householdId)
  if (!c) throw mealieNotConnected()
  return c
}

// Never includes the token.
export function presentConnection(c: MealieConn | null) {
  if (!c) return { connected: false }
  return {
    connected: true,
    baseUrl: c.baseUrl,
    publicUrl: c.publicUrl,
    shoppingListId: c.shoppingListId,
    shoppingListName: c.shoppingListName,
    mealieVersion: c.mealieVersion,
  }
}

export async function listShoppingLists(target: MealieTarget): Promise<{ id: string; name: string }[]> {
  const page = await mealieFetch<{ items?: { id: string; name: string }[] }>(target, '/api/households/shopping/lists?perPage=100')
  return (page.items ?? []).map((l) => ({ id: l.id, name: l.name }))
}

export interface SaveInput {
  baseUrl: unknown
  publicUrl?: unknown
  token?: unknown
  shoppingListId?: unknown
}

const badRequest = (m: string) => new MealieError('BadRequest', m, 400)

export async function saveConnection(householdId: string, personId: string, input: SaveInput): Promise<MealieConn> {
  if (!encryptionAvailable()) throw new MealieError('EncryptionUnavailable', "Encryption isn't configured on this server", 500)
  const existing = await getConnection(householdId)
  const baseUrl = normalizeBaseUrl(String(input.baseUrl ?? ''))
  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : existing?.token
  if (!token) throw badRequest('A Mealie API token is required')

  let publicUrl = existing?.publicUrl ?? null
  if (input.publicUrl !== undefined) publicUrl = input.publicUrl ? normalizeBaseUrl(String(input.publicUrl)) : null

  const about = await mealieFetch<{ version?: string }>({ baseUrl }, '/api/app/about')
  const version = about.version ?? null
  const major = parseInt(version ?? '', 10)
  if (Number.isFinite(major) && major < 2) throw badRequest('Mealie 2.0 or newer is required')

  try {
    await mealieFetch({ baseUrl, token }, '/api/users/self')
  } catch (e) {
    if (e instanceof MealieError && e.name === 'MealieAuthFailed') throw badRequest('Mealie rejected that token')
    throw e
  }

  let listId = existing?.shoppingListId ?? null
  let listName = existing?.shoppingListName ?? null
  if (input.shoppingListId !== undefined) {
    if (!input.shoppingListId) {
      listId = null
      listName = null
    } else {
      const found = (await listShoppingLists({ baseUrl, token })).find((l) => l.id === input.shoppingListId)
      if (!found) throw badRequest('That shopping list was not found in Mealie')
      listId = found.id
      listName = found.name
    }
  }

  await query(
    `insert into mealie_connections
       (household_id, base_url, token_encrypted, shopping_list_id, shopping_list_name, public_url, mealie_version, connected_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (household_id) do update set
       base_url = excluded.base_url, token_encrypted = excluded.token_encrypted,
       shopping_list_id = excluded.shopping_list_id, shopping_list_name = excluded.shopping_list_name,
       public_url = excluded.public_url, mealie_version = excluded.mealie_version,
       connected_by = excluded.connected_by, updated_at = now()`,
    [householdId, baseUrl, encryptSecret(token), listId, listName, publicUrl, version, personId]
  )
  cacheClear(householdId)
  return { baseUrl, publicUrl, token, shoppingListId: listId, shoppingListName: listName, mealieVersion: version }
}

export async function deleteConnection(householdId: string): Promise<void> {
  await query('delete from mealie_connections where household_id = $1', [householdId])
  cacheClear(householdId)
}
