// Mealie integration client. Mirrors the DTOs in apps/api/src/modules/mealie/.
// Reads use apiSend('GET') because apiGet drops the error body that carries the code.
import { useCallback, useEffect, useState } from 'react'
import { apiSend, ApiSendError } from './client'
import { emit, useRefetchOn, useLiveRefresh } from './bus'

export interface MealieEntry {
  id: number
  date: string
  entryType: string
  title: string
  recipe: { id: string; slug: string; name: string; imageUrl: string | null } | null
}

export interface MealieRecipeCard {
  id: string
  slug: string
  name: string
  imageUrl: string | null
  totalTime: string | null
  description: string | null
}

export interface MealieRecipeDetail {
  id: string
  slug: string
  name: string
  imageUrl: string | null
  description: string | null
  totalTime: string | null
  recipeYield: string | null
  ingredients: { title: string | null; display: string }[]
  steps: { title: string | null; text: string }[]
  mealieUrl: string
}

export interface MealieShoppingItem {
  id: string
  display: string
  checked: boolean
  label: { name: string; color: string | null } | null
  position: number
}

export interface MealieShopping {
  listId: string
  listName: string
  items: MealieShoppingItem[]
}

export interface MealieConnection {
  connected: boolean
  baseUrl?: string
  publicUrl?: string | null
  shoppingListId?: string | null
  shoppingListName?: string | null
  mealieVersion?: string | null
}

export interface MealieConnectionInput {
  baseUrl: string
  publicUrl?: string
  token?: string
  shoppingListId?: string
}

export type MealieErrorCode = 'MealieUnavailable' | 'MealieAuthFailed' | 'MealieNoShoppingList' | 'MealieNotConnected'
const CODES: string[] = ['MealieUnavailable', 'MealieAuthFailed', 'MealieNoShoppingList', 'MealieNotConnected']

export function mealieErrorCode(e: unknown): MealieErrorCode | null {
  if (!(e instanceof ApiSendError)) return null
  const code = e.body?.error
  return typeof code === 'string' && CODES.includes(code) ? (code as MealieErrorCode) : null
}

const done = <T>(r: T): T => { emit('mealie'); return r }
const get = <T>(path: string) => apiSend<T>('GET', path)

export const mealieApi = {
  connection: () => get<MealieConnection>('/api/mealie/connection'),
  saveConnection: (input: MealieConnectionInput) => apiSend<MealieConnection>('PUT', '/api/mealie/connection', input).then(done),
  disconnect: () => apiSend<void>('DELETE', '/api/mealie/connection').then(done),
  shoppingLists: () => get<{ id: string; name: string }[]>('/api/mealie/shopping-lists'),
  mealplan: (start: string, end: string) => get<{ entries: MealieEntry[] }>(`/api/mealie/mealplan?start=${start}&end=${end}`),
  recipes: (opts: { search?: string; page?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.search) qs.set('search', opts.search)
    if (opts.page) qs.set('page', String(opts.page))
    const s = qs.toString()
    return get<{ items: MealieRecipeCard[]; page: number; totalPages: number }>(`/api/mealie/recipes${s ? `?${s}` : ''}`)
  },
  recipe: (slug: string) => get<{ recipe: MealieRecipeDetail }>(`/api/mealie/recipes/${encodeURIComponent(slug)}`),
  shopping: () => get<MealieShopping>('/api/mealie/shopping'),
  addItem: (text: string) => apiSend<{ ok: true }>('POST', '/api/mealie/shopping/items', { text }).then(done),
  setChecked: (id: string, checked: boolean) => apiSend<{ ok: true }>('PATCH', `/api/mealie/shopping/items/${encodeURIComponent(id)}`, { checked }).then(done),
  plan: (input: { date: string; entryType: string; recipeId?: string; title?: string }) =>
    apiSend<{ ok: true }>('POST', '/api/mealie/mealplan', input).then(done),
  unplan: (id: number) => apiSend<void>('DELETE', `/api/mealie/mealplan/${id}`).then(done),
}

// Shared by every Mealie-backed view: refetches on the bus and on a poll.
// With enabled=false it neither loads nor reacts to the bus or the poll.
export function useMealieQuery<T>(load: () => Promise<T>, deps: unknown[], enabled = true): { data: T | null; error: unknown; retry: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [nonce, setNonce] = useState(0)
  const retry = useCallback(() => setNonce((n) => n + 1), [])
  const refetch = useCallback(() => { if (enabled) retry() }, [enabled, retry])
  useRefetchOn(['mealie'], refetch)
  useLiveRefresh(refetch)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    load().then((d) => { if (alive) { setData(d); setError(null) } }).catch((e) => { if (alive) setError(e) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, enabled, ...deps])
  return { data, error, retry }
}
