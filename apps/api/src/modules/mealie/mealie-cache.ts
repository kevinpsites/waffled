// Small in-process TTL cache so a kiosk polling Mealie doesn't hammer it. Keyed per household.
export type CacheKind = 'plan' | 'recipes' | 'recipe' | 'shopping'

const TTL_MS: Record<CacheKind, number> = { plan: 30_000, recipes: 60_000, recipe: 300_000, shopping: 10_000 }

interface Entry {
  expires: number
  value: unknown
}

const store = new Map<string, Entry>()
const keyOf = (householdId: string, kind: CacheKind, key: string) => `${householdId}|${kind}|${key}`

export async function cacheGet<T>(householdId: string, kind: CacheKind, key: string, load: () => Promise<T>): Promise<T> {
  const k = keyOf(householdId, kind, key)
  const hit = store.get(k)
  if (hit && hit.expires > Date.now()) return hit.value as T
  const value = await load()
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
