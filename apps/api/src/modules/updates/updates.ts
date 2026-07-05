// In-app update notifier (admin-only). Checks the configured GitHub repo's latest
// release and reports whether a newer version is available, so an operator sees "you're
// behind" in Settings → System Health without watching the repo.
//
// Two off-switches: UPDATE_CHECK_ENABLED=false is the operator kill-switch (privacy /
// air-gapped — no outbound call ever), and a per-household admin toggle lives in
// settings.updateCheck.enabled. Never throws: any network error is captured, and the
// GitHub result is cached (6h) so we never hammer their API or block the panel.
import createAPI from 'lambda-api'
import { query } from '../../platform/db'
import { version } from '../../platform/version'
import { adminRoute } from '../../platform/route-guards'

type Api = ReturnType<typeof createAPI>

interface LatestRelease {
  tag: string
  url: string
  publishedAt: string | null
}
interface Cache {
  at: number
  release: LatestRelease | null
  error?: string
}
let cache: Cache | null = null
const TTL_MS = 6 * 60 * 60 * 1000 // 6h

const envEnabled = (): boolean => (process.env.UPDATE_CHECK_ENABLED ?? 'true') !== 'false'
const repo = (): string => (process.env.UPDATE_CHECK_REPO || '').trim() // "owner/name"

async function householdEnabled(householdId: string): Promise<boolean> {
  const { rows } = await query<{ enabled: boolean | null }>(
    `select (settings->'updateCheck'->>'enabled')::boolean as enabled from households where id = $1`,
    [householdId]
  )
  return rows[0]?.enabled !== false // default on unless explicitly disabled
}

async function setHouseholdEnabled(householdId: string, enabled: boolean): Promise<void> {
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('updateCheck', jsonb_build_object('enabled', $2::boolean))
      where id = $1`,
    [householdId, enabled]
  )
}

// Naive semver compare: true if a > b. Anything non-numeric (e.g. the 0.0.0 dev
// placeholder or a weird tag) → false, so we never nag before a real release/version.
export function isNewer(a: string, b: string): boolean {
  const parse = (s: string) => s.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10))
  const pa = parse(a)
  const pb = parse(b)
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false
  if (pb.every((n) => n === 0)) return false // unreleased dev build (0.0.0): don't claim an update
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

async function fetchLatest(): Promise<Cache> {
  const r = repo()
  if (!r) return { at: Date.now(), release: null, error: 'UPDATE_CHECK_REPO not set' }
  try {
    const res = await fetch(`https://api.github.com/repos/${r}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'waffled' },
    })
    if (!res.ok) return { at: Date.now(), release: null, error: `GitHub ${res.status}` }
    const j = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string }
    if (!j.tag_name) return { at: Date.now(), release: null, error: 'no releases yet' }
    return { at: Date.now(), release: { tag: j.tag_name, url: j.html_url ?? '', publishedAt: j.published_at ?? null } }
  } catch (err) {
    return { at: Date.now(), release: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function getLatest(): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache
  cache = await fetchLatest()
  return cache
}

export function registerUpdateRoutes(api: Api): void {
  api.get('/api/updates', adminRoute(async (tenant) => {
    const current = { version: version.pkg, sha: version.sha }
    if (!envEnabled()) return { enabled: false, reason: 'env', current }
    if (!(await householdEnabled(tenant.householdId))) return { enabled: false, current }
    const c = await getLatest()
    const latest = c.release
    const updateAvailable = !!latest && isNewer(latest.tag, version.pkg)
    return {
      enabled: true,
      current,
      latest,
      updateAvailable,
      checkedAt: new Date(c.at).toISOString(),
      ...(c.error ? { error: c.error } : {}),
    }
  }))

  api.put('/api/updates/settings', adminRoute(async (tenant, req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'enabled must be boolean' })
    }
    await setHouseholdEnabled(tenant.householdId, body.enabled)
    return { enabled: body.enabled }
  }))
}
