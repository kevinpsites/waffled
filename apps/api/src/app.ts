// The shared lambda-api app: one routes file, two entrypoints (server.ts, lambda.ts).
import { randomUUID } from 'node:crypto'
import createAPI, { type Request, type Response, type NextFunction } from 'lambda-api'
import { config } from './platform/config'
import { requireAuth } from './platform/auth'
import { query } from './platform/db'
import { log } from './platform/logger'
import { version } from './platform/version'
import { recordHttpRequest } from './platform/telemetry'
import { sensitiveRouteRateLimit } from './platform/rate-limit'
import { registerHealthRoutes } from './modules/health/health'
import { registerUpdateRoutes } from './modules/updates/updates'
import {
  resolveTenant,
  requireTenant,
  requireAdmin,
  getContext,
  createHouseholdForAccount,
  presentHousehold,
  presentPerson,
  type Tenant,
} from './modules/households/households'
import { authenticateApiKey, enforceApiKeyScope, registerApiKeyRoutes } from './modules/api-keys/api-keys'
import { registerPersonRoutes, HEX_COLOR } from './modules/persons/persons'
import { registerListRoutes } from './modules/lists/lists.routes'
import { registerPantryRoutes } from './modules/pantry/pantry'
import { registerChoreRoutes } from './modules/chores/chores.routes'
import { registerRewardRoutes } from './modules/rewards/rewards'
import { registerCurrencyRoutes } from './modules/currencies/currencies'
import { registerMealRoutes } from './modules/meals/meals.routes'
import { registerEventRoutes } from './modules/events/events'
import { registerCountdownRoutes } from './modules/countdowns/countdowns'
import { registerFamilyNightRoutes } from './modules/familyNight/familyNight.routes'
import { registerWeeklyPlanningRoutes } from './modules/weeklyPlanning/weeklyPlanning.routes'
import { registerRhythmRoutes } from './modules/rhythms/rhythms.routes'
import { registerCalendarAiRoutes } from './modules/calendar/calendar-ai'
import { registerCalendarRoutes } from './modules/calendar/calendars'
import { registerCalendarSyncRoutes } from './modules/calendar/calendar-sync.routes'
import { registerIcsFeedRoutes } from './modules/calendar/ics-feeds'
import { registerGoalRoutes } from './modules/goals/goals.routes'
import { registerGoalCalendarRoutes } from './modules/goals/goal-calendar'
import { registerOverviewRoutes } from './modules/overview/overview'
import { registerPermissionRoutes } from './modules/permissions/permissions.routes'
import { resolveCapabilities } from './platform/permissions'
import { registerAuthRoutes } from './modules/auth/auth'
import { registerAccountRoutes } from './modules/account/account'
import { listMemberships, pendingInvitesForEmail } from './modules/auth/accounts'
import { registerInviteRoutes } from './modules/auth/invites'
import { registerOidcRoutes } from './modules/auth/oidc'
import { registerKioskRoutes } from './modules/kiosk/kiosk'
import { registerWaffledBiteRoutes } from './modules/waffledBites/waffledBites'
import { registerTodayLayoutRoutes } from './modules/layout/today-layout'
import { registerMobileTodayLayoutRoutes } from './modules/layout/mobile-today-layout'
import { registerPhotoRoutes } from './modules/photos/photos'
import { registerMediaRoutes } from './modules/media/media'
import { registerCaptureRoutes } from './modules/capture/capture'
import { registerWeatherRoutes } from './integrations/weather'
import { registerPowerSyncRoutes } from './modules/powersync/powersync'
import { registerPowerSyncCrudRoutes } from './modules/powersync/powersync-crud'

const api = createAPI()

// Request context: tag every request with an id + start time, before the auth gate so even
// rejected (401/403) requests are logged. The matching `request` log line is emitted in
// api.finally() — lambda-api's next() isn't awaitable, so timing/status are captured there.
api.use((req: Request, _res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID()
  ;(req as Request & { requestId?: string; startTime?: number }).requestId = requestId
  ;(req as Request & { startTime?: number }).startTime = Date.now()
  next()
})

// Bound credential guessing and expensive public flows BEFORE authentication so failed
// attempts consume quota too. Process-local on purpose: the bundled stack runs one API process.
api.use(sensitiveRouteRateLimit)

// Routes that skip auth. /api/auth/keys is the JWKS PowerSync fetches; the Google calendar
// callback arrives as a browser redirect (no Authorization header) and authenticates via its
// one-time OAuth state instead.
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/api/auth/keys',
  '/auth/google/calendar/callback',
  // Microsoft's redirect likewise arrives with no Authorization header; the
  // one-time OAuth state row authenticates it (see calendars.ts).
  '/auth/microsoft/calendar/callback',
  // Built-in auth: setup/login/refresh/status run before a session exists.
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  // OIDC login dance runs before a session exists (admin config routes stay gated).
  '/api/auth/oidc/start',
  '/api/auth/oidc/callback',
  '/api/auth/oidc/exchange',
  // Kiosk pairing: both authenticate via a code/secret in the body, pre-session.
  '/api/kiosk/pair',
  '/api/kiosk/device/token',
  // Waffled-Bites pairing: same shape, pre-session.
  '/api/waffled-bites/pair',
  '/api/waffled-bites/device/token',
])

// Auth gate — authenticates every non-public route. An `x-api-key` header takes the API-key
// path: it resolves to the owning person and is scope-checked centrally here against a
// path-prefix catalog. Central because that is fail-closed by construction — a route absent
// from the catalog is 403, so a new route family cannot accidentally be key-reachable (see
// api-keys.ts). Otherwise the Bearer JWT is verified. Either failure throws AuthError.
api.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path)) return next()
  const apiKeyHeader = req.headers['x-api-key']
  if (typeof apiKeyHeader === 'string' && apiKeyHeader) {
    await authenticateApiKey(req, apiKeyHeader)
    enforceApiKeyScope(req)
    return next()
  }
  await requireAuth(req)
  next()
})

// --- routes ---

// Liveness + a fast DB readiness ping + build info. Stays shallow: it backs the compose
// healthcheck, which only checks for HTTP 200, so a DB blip surfaces in the body's `db`
// field without flapping the container. The deep report is GET /api/health (admin).
api.get('/healthz', async () => {
  let db: 'up' | 'down' = 'up'
  try {
    await query('select 1')
  } catch {
    db = 'down'
  }
  return { ok: true, service: 'waffled-api', authMode: config.auth.mode, version, db }
})

// Who the token says you are (no DB).
api.get('/api/me', async (req: Request) => ({ sub: req.principal?.sub }))

// Your household + person, or { provisioned: false } if you haven't onboarded yet.
api.get('/api/household', async (req: Request) => {
  const tenant = (req as Request & { apiKeyTenant?: Tenant }).apiKeyTenant ?? (await resolveTenant(req.principal!))
  if (!tenant) return { provisioned: false }
  const { household, person } = await getContext(tenant)
  // Capabilities the client can gate UI on (admin ⇒ all; else per-role matrix).
  const capabilities = resolveCapabilities(person.member_type, person.is_admin, household.settings)
// The account's other memberships + pending invites drive the web household switcher /
// invite prompt on any page load. Account-less callers (kiosk/device person) get empty arrays.
  const acct = await query<{ account_id: string | null; email: string | null }>(
    `select p.account_id, a.email from persons p left join accounts a on a.id = p.account_id and a.deleted_at is null where p.id = $1`,
    [tenant.personId]
  )
  const accountId = acct.rows[0]?.account_id ?? null
  const accountEmail = acct.rows[0]?.email ?? null
  const memberships = accountId ? await listMemberships(accountId) : []
  const pendingInvites = accountEmail ? await pendingInvitesForEmail(accountEmail) : []
  return {
    provisioned: true,
    household: presentHousehold(household),
    person: { ...presentPerson(person), capabilities },
    memberships,
    pendingInvites,
  }
})

// Admin-gated additional-household creation. The FIRST household comes from the first-run
// wizard (/api/auth/setup); here an existing ADMIN spins up an additional one (becoming its
// owner), linked to their existing account. Self-serve onboarding is deferred.
api.post('/api/households', async (req: Request, res: Response) => {
  const tenant = await requireTenant(req) // 401 (no token) / 403 (unprovisioned) from upstream/AuthError
  requireAdmin(tenant) // 403 if not admin

  const body = (req.body ?? {}) as {
    name?: string
    timezone?: string
    person?: { name?: string; avatarEmoji?: string; colorHex?: string }
  }
  if (!body.name || !body.timezone || !body.person?.name) {
    return res
      .status(400)
      .json({ error: 'BadRequest', message: 'name, timezone, and person.name are required' })
  }
  if (body.person.colorHex != null && !HEX_COLOR.test(String(body.person.colorHex))) {
    return res.status(400).json({ error: 'BadRequest', message: 'person.colorHex must be a #RRGGBB hex color' })
  }

  const ar = await query<{ account_id: string | null }>(
    `select account_id from persons where id = $1`,
    [tenant.personId]
  )
  const accountId = ar.rows[0]?.account_id
  if (!accountId) {
    return res.status(403).json({ error: 'Forbidden', message: 'This session has no account.' })
  }

  const { household, person } = await createHouseholdForAccount(accountId, {
    householdName: body.name,
    timezone: body.timezone,
    person: {
      name: body.person.name,
      avatarEmoji: body.person.avatarEmoji ?? null,
      colorHex: body.person.colorHex ?? null,
    },
  })
  return res
    .status(201)
    .json({ household: presentHousehold(household), person: presentPerson(person) })
})

registerPersonRoutes(api)

registerListRoutes(api)

// Pantry (/api/pantry…) — optional module, gated per household
registerPantryRoutes(api)

registerChoreRoutes(api)

registerRewardRoutes(api)

registerCurrencyRoutes(api)

registerMealRoutes(api)

registerEventRoutes(api)

// Countdowns (/api/countdowns…) — core Calendar feature, not a gated module
registerCountdownRoutes(api)

// Family Night (/api/family-night…) — optional module
registerFamilyNightRoutes(api)
registerWeeklyPlanningRoutes(api)

// Rhythms (/api/rhythms…) — optional module
registerRhythmRoutes(api)

registerCalendarAiRoutes(api)

registerCalendarRoutes(api)

registerCalendarSyncRoutes(api)

// ICS feed subscriptions (/api/calendar/feeds…) — read-only URL calendars
registerIcsFeedRoutes(api)

registerGoalRoutes(api)

registerGoalCalendarRoutes(api)

registerAuthRoutes(api)
registerAccountRoutes(api)
registerInviteRoutes(api)
registerOidcRoutes(api)

registerKioskRoutes(api)

registerWaffledBiteRoutes(api)

registerOverviewRoutes(api)

// Role capability matrix (/api/permissions) — admin reads/edits chore+reward gates
registerPermissionRoutes(api)

// Today dashboard card layout (/api/today-layout) — family default + user override
registerTodayLayoutRoutes(api)
// Mobile Today card layout (/api/today-layout/mobile) — phone-specific config
registerMobileTodayLayoutRoutes(api)

registerPhotoRoutes(api)

registerMediaRoutes(api)

registerCaptureRoutes(api)

registerWeatherRoutes(api)

registerPowerSyncRoutes(api)

registerPowerSyncCrudRoutes(api)

// Per-user API keys (/api/api-keys…) — mint/list/revoke; the keys themselves auth
// via the x-api-key header in the gate above.
registerApiKeyRoutes(api)

registerHealthRoutes(api)

registerUpdateRoutes(api)

// One structured access-log line per request, after the response is sent. status & duration
// are read here because lambda-api's next() doesn't return a promise.
api.finally((req: Request, res: Response) => {
  const r = req as Request & { requestId?: string; startTime?: number; tenantHouseholdId?: string }
  const status = (res as Response & { _statusCode?: number })._statusCode
  log.info('request', {
    requestId: r.requestId,
    method: req.method,
    path: req.path,
    status,
    durationMs: r.startTime ? Date.now() - r.startTime : undefined,
    householdId: r.tenantHouseholdId,
  })
  recordHttpRequest({ method: req.method, status }) // OTEL counter (no-op when off)
})

// Error handler — lambda-api treats a 4-arg middleware as the error sink.
api.use(
  (err: Error & { statusCode?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode ?? 500
    if (status >= 500) {
      log.error('unhandled', { err, requestId: (req as Request & { requestId?: string }).requestId })
    }
    res.status(status).json({ error: err.name || 'Error', message: err.message })
  }
)

export default api
