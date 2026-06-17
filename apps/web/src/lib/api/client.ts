// Shared fetch helpers for the api client. In dev, Vite proxies /api to the api
// container; in the stack, Caddy does. The kiosk token is a dev shortcut for now
// — a real device pairing flow (chunk 3.3) replaces it later. Set it via
// localStorage ('nook.token') at runtime, or VITE_KIOSK_TOKEN at build time.
function token(): string | undefined {
  try {
    const t = localStorage.getItem('nook.token')
    if (t) return t
  } catch {
    /* localStorage unavailable */
  }
  return import.meta.env.VITE_KIOSK_TOKEN || undefined
}

export async function apiGet<T>(path: string): Promise<T> {
  const t = token()
  const res = await fetch(path, { headers: t ? { authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

// Short-lived GET cache for idempotent, expensive reads (e.g. the AI cards): a
// mount within the TTL reuses the in-flight/last promise instead of firing the
// same request again — so navigating away and back doesn't re-run the model. A
// failed request is evicted so the next mount retries.
const getCache = new Map<string, { at: number; p: Promise<unknown> }>()
export function apiGetCached<T>(path: string, ttlMs: number): Promise<T> {
  const hit = getCache.get(path)
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>
  const p = apiGet<T>(path)
  getCache.set(path, { at: Date.now(), p })
  p.catch(() => { if (getCache.get(path)?.p === p) getCache.delete(path) })
  return p
}
// Drop cached GETs by path prefix (e.g. after editing an event) so the next read is fresh.
export function invalidateGetCache(prefix: string): void {
  for (const k of [...getCache.keys()]) if (k.startsWith(prefix)) getCache.delete(k)
}

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const t = token()
  const res = await fetch(path, {
    method,
    headers: {
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  const t = token()
  const res = await fetch(path, { method: 'DELETE', headers: t ? { authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`)
}

// Local YYYY-MM-DD (kiosk timezone), used to match "tonight" and window the week.
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
