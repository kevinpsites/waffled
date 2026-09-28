// Per-user API keys (Immich-style). A key is a long random secret shown once on creation
// and stored only as a sha256 hash. Callers present it in the `x-api-key` header instead
// of a Bearer JWT; the key resolves to its owner person, and its SCOPES bound which
// resource families it may touch. Two layers of gating, kept deliberately separate:
//   1. Scope — does the key hold `<resource>:<read|write>` for this path? Enforced
//      centrally in the auth gate (app.ts) against a path-PREFIX catalog. Declaring the
//      scope at the route is the intended direction — see
//      docs/product/api-key-scopes-plan.md, which covers why the naive move is fail-OPEN.
//   2. Capability — the in-route requireCapability/requireAdmin still run, so a teen's
//      key can never exceed the teen's rights even with a broad scope.
// Only paths mapped in API_SCOPES are reachable by a key at all, so auth, kiosk,
// permissions, key management and PowerSync always 403 for key-authenticated requests.
// Both halves of that decision are declared here: API_SCOPES is the allow list, and
// NEVER_KEY_REACHABLE / UNSCOPED_YET name the paths held back on purpose. Absence from
// both still denies, so the deny list adds no gate — it makes a deliberate exclusion
// reviewable beside the routes, and tells `forgotten` apart from `excluded`.
import { createHash, randomBytes } from 'node:crypto'
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { AuthError } from '../../platform/auth'
import { tenantRoute } from '../../platform/route-guards'
import type { Tenant } from '../households/households'

type Api = ReturnType<typeof createAPI>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

declare module 'lambda-api' {
  interface Request {
    apiKey?: { id: string; scopes: string[] }
    apiKeyTenant?: Tenant
  }
}

// Each resource maps to one or more path prefixes. `read` covers GET/HEAD; any other method
// needs `write`. This is the single source of truth — the create UI reads it from
// GET /api/api-keys/scopes, so the web client never hard-codes the list.
export interface ApiScopeDef {
  resource: string
  label: string
  description: string
  prefixes: string[]
  readOnly?: boolean
}

export const API_SCOPES: ApiScopeDef[] = [
  { resource: 'family', label: 'Family', description: 'Household, members, and overviews', prefixes: ['/api/household', '/api/persons', '/api/family'], readOnly: true },
  // `pantry-staples` reads like pantry but is a lists route, registered behind
  // moduleRoutes('lists') — so a pantry-scoped key would clear the scope gate only to 403.
  { resource: 'lists', label: 'Lists', description: 'Grocery and to-do lists', prefixes: ['/api/lists', '/api/pantry-staples'] },
  { resource: 'pantry', label: 'Pantry', description: 'On-hand inventory', prefixes: ['/api/pantry'] },
  { resource: 'chores', label: 'Chores', description: 'Chores and completions', prefixes: ['/api/chores', '/api/chore-instances', '/api/chore-proofs'] },
  { resource: 'rewards', label: 'Rewards', description: 'Rewards, balances, currencies, and conversions', prefixes: ['/api/rewards', '/api/redemptions', '/api/balances', '/api/currencies', '/api/conversions'] },
  { resource: 'meals', label: 'Meals', description: 'Recipes and meal planning', prefixes: ['/api/recipes', '/api/meals'] },
  { resource: 'calendar', label: 'Calendar', description: 'Calendar events', prefixes: ['/api/events'] },
  { resource: 'goals', label: 'Goals', description: 'Goals and progress', prefixes: ['/api/goals', '/api/goal-lists'] },
  { resource: 'photos', label: 'Photos', description: 'Photos and memories', prefixes: ['/api/photos'] },
  { resource: 'weather', label: 'Weather', description: 'Local weather', prefixes: ['/api/weather'], readOnly: true },
]

export const ALL_SCOPES: string[] = API_SCOPES.flatMap((s) =>
  s.readOnly ? [`${s.resource}:read`] : [`${s.resource}:read`, `${s.resource}:write`]
)

// Paths deliberately held back from keys. Two buckets because they make different claims:
// NEVER_KEY_REACHABLE is a decision, UNSCOPED_YET is debt and its `tracked` must name where
// that work lives. They gate identically — the split is for the reader. Adding a route
// family? Give its prefix a resource above, or list it here.
export interface NeverReachable {
  why: string
  prefixes: string[]
}
export interface UnscopedYet extends NeverReachable {
  tracked: string
}

export const NEVER_KEY_REACHABLE: NeverReachable[] = [
  { why: 'public liveness probe', prefixes: ['/healthz'] },
  { why: 'echoes the token sub — tells a key nothing it does not already know', prefixes: ['/api/me'] },
  { why: 'login, OIDC, invites and self-service account are session-only', prefixes: ['/api/auth', '/auth', '/api/account', '/api/households'] },
  { why: 'a key can never mint or manage keys', prefixes: ['/api/api-keys'] },
  { why: 'kiosk and Waffled-Bite pairing run on their own device tokens', prefixes: ['/api/kiosk', '/api/waffled-bites'] },
  { why: 'the capability grid is an admin session surface', prefixes: ['/api/permissions'] },
  { why: 'offline sync is the first-party clients own transport', prefixes: ['/api/powersync'] },
  { why: 'LLM capture and the blob upload sink are first-party client surfaces', prefixes: ['/api/capture', '/api/media'] },
  { why: 'integrations surface — documented as always 403 for a key', prefixes: ['/api/countdowns', '/api/family-night', '/api/goal-calendar', '/api/calendar'] },
  { why: 'per-viewer UI layout, not household data', prefixes: ['/api/today-layout'] },
  { why: 'operator surfaces (deep health report, update channel)', prefixes: ['/api/health', '/api/updates'] },
]

export const UNSCOPED_YET: UnscopedYet[] = [
  // The same boundary bug as /api/chore-instances. PR #180 adds the prefix, so this entry
  // only keeps the guard green until it lands.
  { why: 'a lists route that the /api/lists prefix cannot match', prefixes: ['/api/list-items'], tracked: 'PR #180' },
  { why: 'rhythms wants a whole new scope resource, not another prefix — nobody has designed it', prefixes: ['/api/rhythms'], tracked: 'docs/product/api-key-scopes-plan.md' },
  // Debt rather than a boundary, and the distinction is the point: a planning session WRITES
  // THROUGH to other modules, so with one scope per prefix a `weeklyPlanning` scope would be
  // a skeleton key past `chores:write` and the rest. Per-route, each asks for what it needs.
  { why: 'no correct scope exists under one-scope-per-prefix — a session writes through to chores/goals/events/meals', prefixes: ['/api/weekly-planning'], tracked: 'docs/product/api-key-scopes-plan.md' },
]

export const NOT_KEY_REACHABLE: (NeverReachable | UnscopedYet)[] = [...NEVER_KEY_REACHABLE, ...UNSCOPED_YET]

// A prefix matches only on a `/` boundary, so a hyphenated sibling of a listed
// prefix (/api/chore-instances vs /api/chores) does NOT match — it has to be listed
// explicitly above. Do not "fix" that by dropping the boundary: a bare startsWith
// would make /api/households/invites match the read-only `family` prefix
// /api/household, quietly making the invite list readable with `family:read`.
function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + '/')
}

// The entry that excludes this path, or null. Same `/` boundary rule as the allow list.
export function denyForPath(path: string): NeverReachable | UnscopedYet | null {
  for (const entry of NOT_KEY_REACHABLE) {
    if (entry.prefixes.some((p) => pathMatches(p, path))) return entry
  }
  return null
}

// What a key needs to hold, or null if the path isn't exposed to API keys at all (→ 403).
// `denied` flags a write to a read-only resource.
export function scopeForRequest(
  method: string,
  path: string
): { resource: string; action: 'read' | 'write'; required: string; denied?: boolean } | null {
  // Longest matching prefix wins, so a more specific resource beats a broad one.
  let best: ApiScopeDef | null = null
  let bestLen = -1
  for (const def of API_SCOPES) {
    for (const p of def.prefixes) {
      if (pathMatches(p, path) && p.length > bestLen) {
        best = def
        bestLen = p.length
      }
    }
  }
  if (!best) return null
  const action: 'read' | 'write' = method === 'GET' || method === 'HEAD' ? 'read' : 'write'
  if (action === 'write' && best.readOnly) {
    return { resource: best.resource, action, required: `${best.resource}:write`, denied: true }
  }
  return { resource: best.resource, action, required: `${best.resource}:${action}` }
}

// A `:write` scope implies `:read` for the same resource.
export function keyHasScope(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true
  if (required.endsWith(':read')) return scopes.includes(required.slice(0, -5) + ':write')
  return false
}

function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function mintKey(): { secret: string; hash: string; prefix: string } {
  const secret = 'waffled_' + randomBytes(32).toString('base64url')
  return { secret, hash: hashKey(secret), prefix: secret.slice(0, 12) }
}

// Resolve a presented key to its owner tenant and stash it on the request. Throws
// AuthError(401) when the key is unknown, revoked, or expired.
export async function authenticateApiKey(req: Request, rawKey: string): Promise<void> {
  const { rows } = await query<{
    id: string
    scopes: string[]
    person_id: string
    household_id: string
    is_admin: boolean
    member_type: string
  }>(
    `select k.id, k.scopes, k.person_id, p.household_id, p.is_admin, p.member_type
       from api_keys k
       join persons p on p.id = k.person_id and p.deleted_at is null
      where k.key_hash = $1
        and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())`,
    [hashKey(rawKey)]
  )
  const r = rows[0]
  if (!r) throw new AuthError('Invalid or expired API key')
  req.principal = { sub: `apikey:${r.id}`, claims: {} }
  req.apiKey = { id: r.id, scopes: r.scopes ?? [] }
  req.apiKeyTenant = {
    sub: `apikey:${r.id}`,
    personId: r.person_id,
    householdId: r.household_id,
    isAdmin: r.is_admin,
    memberType: r.member_type,
  }
  // Touch last_used_at, throttled to once a minute so a chatty integration doesn't
  // write on every request.
  await query(
    `update api_keys set last_used_at = now()
      where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [r.id]
  )
}

// Central scope gate for key-authenticated requests. Throws AuthError(403) when the path
// isn't exposed, the action is never allowed, or the key lacks the required scope.
export function enforceApiKeyScope(req: Request): void {
  const scopes = req.apiKey?.scopes ?? []
  // Deny first, so an explicit exclusion wins if a prefix ever lands in both lists. A guard
  // test fails on that contradiction; until someone reads it, the safe answer is taken here.
  // The body below is the SAME one absence produces — a key holder never learns which.
  if (denyForPath(req.path)) {
    throw new AuthError('This endpoint is not available to API keys', 403)
  }
  const need = scopeForRequest(req.method, req.path)
  // Absence still denies: fail-closed by construction, so an uncatalogued route family cannot
  // become key-reachable. Deliberately not logged — this runs on every key-authed request and
  // the logger has no de-dup, so the obvious `log.warn` floods. A method+path Set would not
  // bound it either: `req.path` is the concrete URL, so unrouted paths grow it without limit.
  if (!need || need.denied) {
    throw new AuthError('This endpoint is not available to API keys', 403)
  }
  if (!keyHasScope(scopes, need.required)) {
    throw new AuthError(`API key is missing the required scope: ${need.required}`, 403)
  }
}

// ── management routes (session/Bearer only — /api/api-keys isn't in the scope
// catalog, so key-authenticated callers can't reach these) ────────────────────────
interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  scopes: string[]
  last_used_at: Date | null
  expires_at: Date | null
  created_at: Date
}

function present(r: ApiKeyRow) {
  return {
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    scopes: r.scopes ?? [],
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }
}

export function registerApiKeyRoutes(api: Api): void {
  api.get('/api/api-keys/scopes', tenantRoute(async () => ({ scopes: API_SCOPES })))

  // The caller's own keys (metadata only — the secret is never retrievable).
  api.get('/api/api-keys', tenantRoute(async (tenant) => {
    const { rows } = await query<ApiKeyRow>(
      `select id, name, key_prefix, scopes, last_used_at, expires_at, created_at
         from api_keys
        where person_id = $1 and revoked_at is null
        order by created_at desc`,
      [tenant.personId]
    )
    return { keys: rows.map(present) }
  }))

  // Mint a key. The full secret is returned exactly once, here.
  api.post('/api/api-keys', tenantRoute(async (tenant, req: Request, res: Response) => {
    const b = (req.body ?? {}) as { name?: unknown; scopes?: unknown; expiresAt?: unknown }
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return res.status(400).json({ error: 'BadRequest', message: 'name is required' })

    const requested = Array.isArray(b.scopes) ? b.scopes.map(String) : []
    const scopes = [...new Set(requested)]
    if (scopes.length === 0) return res.status(400).json({ error: 'BadRequest', message: 'at least one scope is required' })
    const unknown = scopes.filter((s) => !ALL_SCOPES.includes(s))
    if (unknown.length) return res.status(400).json({ error: 'BadRequest', message: `unknown scope(s): ${unknown.join(', ')}` })

    let expiresAt: string | null = null
    if (b.expiresAt != null && b.expiresAt !== '') {
      const t = Date.parse(String(b.expiresAt))
      if (Number.isNaN(t)) return res.status(400).json({ error: 'BadRequest', message: 'expiresAt must be an ISO date' })
      expiresAt = new Date(t).toISOString()
    }

    const { secret, hash, prefix } = mintKey()
    const { rows } = await query<ApiKeyRow>(
      `insert into api_keys (household_id, person_id, name, key_hash, key_prefix, scopes, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, name, key_prefix, scopes, last_used_at, expires_at, created_at`,
      [tenant.householdId, tenant.personId, name, hash, prefix, scopes, expiresAt]
    )
    return res.status(201).json({ key: secret, apiKey: present(rows[0]) })
  }))

  api.delete('/api/api-keys/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'key not found' })
    const { rowCount } = await query(
      `update api_keys set revoked_at = now()
        where id = $1 and person_id = $2 and revoked_at is null`,
      [id, tenant.personId]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'key not found' })
    return res.status(204).send('')
  }))
}
