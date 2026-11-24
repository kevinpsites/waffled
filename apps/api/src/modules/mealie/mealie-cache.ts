// Small in-process TTL cache so a kiosk polling Mealie doesn't hammer it. Keyed per household.
export type CacheKind = 'plan' | 'recipes' | 'recipe' | 'shopping'

const TTL_MS: Record<CacheKind, number> = { plan: 30_000, recipes: 60_000, recipe: 300_000, shopping: 10_000 }

interface Entry {
  expires: number
  value: unknown
}

const store = new Map<string, Entry>()
const keyOf = (householdId: string, kind: CacheKind, key: string) => `${householdId}|${kind}|${key}`

// Keys embed search/page/range, so without a sweep the map only ever grows.
function sweepExpired(householdId: string): void {
  const now = Date.now()
  const prefix = `${householdId}|`
  for (const [k, e] of store) if (e.expires <= now && k.startsWith(prefix)) store.delete(k)
}

export async function cacheGet<T>(householdId: string, kind: CacheKind, key: string, load: () => Promise<T>): Promise<T> {
  const k = keyOf(householdId, kind, key)
  const hit = store.get(k)
  if (hit && hit.expires > Date.now()) return hit.value as T
  if (hit) store.delete(k)
  const value = await load()
  sweepExpired(householdId)
  store.set(k, { expires: Date.now() + TTL_MS[kind], value })
  return value
}

export function cacheClear(householdId: string, kind?: CacheKind): void {
  const prefix = kind ? `${householdId}|${kind}|` : `${householdId}|`
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k)
}

export function __resetMealieCache(): void {
  store.clear()
}

export const __mealieCacheSize = (): number => store.size
