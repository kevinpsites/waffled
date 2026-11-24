// Outbound Mealie client. Only fixed paths under the stored base URL are ever requested.
// Errors carry no token: the token only ever travels in the Authorization header.

export class MealieError extends Error {
  statusCode: number
  constructor(name: string, message: string, statusCode: number) {
    super(message)
    this.name = name
    this.statusCode = statusCode
  }
}

export const mealieUnavailable = () => new MealieError('MealieUnavailable', "Can't reach Mealie right now.", 502)
export const mealieAuthFailed = () => new MealieError('MealieAuthFailed', "Mealie stopped accepting Waffled's token.", 502)
export const mealieNotConnected = () => new MealieError('MealieNotConnected', 'Mealie is not connected.', 409)
export const mealieNoShoppingList = () => new MealieError('MealieNoShoppingList', 'No Mealie shopping list is chosen.', 409)

const TIMEOUT_MS = 8000

export interface MealieTarget {
  baseUrl: string
  /** Omit for the unauthenticated endpoints (version check, images). */
  token?: string
}

export function normalizeBaseUrl(raw: string): string {
  const bad = () => new MealieError('InvalidMealieUrl', 'Enter a valid http(s) URL for Mealie', 400)
  let u: URL
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    throw bad()
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad()
  if (u.username || u.password) throw bad()
  return u.toString().replace(/\/+$/, '')
}

async function send(target: MealieTarget, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (target.token) headers.authorization = `Bearer ${target.token}`
  if (init?.body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw mealieUnavailable()
  }
  if (res.status === 401 || res.status === 403) throw mealieAuthFailed()
  return res
}

async function detailOf(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown; message?: unknown }
    if (typeof j.detail === 'string') return j.detail
    if (typeof j.message === 'string') return j.message
  } catch {
    // fall through
  }
  return 'Mealie rejected the request'
}

export async function mealieFetch<T>(target: MealieTarget, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await send(target, path, init)
  if (res.status === 204) return undefined as T
  if (res.status === 404) throw new MealieError('NotFound', 'Not found in Mealie', 404)
  if (res.status === 422) throw new MealieError('BadRequest', await detailOf(res), 400)
  if (!res.ok) throw mealieUnavailable()
  try {
    return (await res.json()) as T
  } catch {
    throw mealieUnavailable()
  }
}

// For the image proxy: returns any non-auth response (including 404) so the caller can decide.
export function mealieFetchRaw(target: MealieTarget, path: string): Promise<Response> {
  return send(target, path)
}
