// The shared lambda-api app: one routes file, two entrypoints (server.ts, lambda.ts).
import createAPI, { type Request, type Response, type NextFunction } from 'lambda-api'
import { config } from './platform/config'
import { requireAuth } from './platform/auth'
import {
  findTenantBySub,
  getContext,
  provisionHousehold,
  presentHousehold,
  presentPerson,
  inferProvider,
} from './modules/households/households'
import { registerPersonRoutes } from './modules/persons/persons'
import { registerListRoutes } from './modules/lists/lists.routes'
import { registerChoreRoutes } from './modules/chores/chores.routes'
import { registerRewardRoutes } from './modules/rewards/rewards'
import { registerCurrencyRoutes } from './modules/currencies/currencies'
import { registerMealRoutes } from './modules/meals/meals.routes'
import { registerEventRoutes } from './modules/events/events'
import { registerCalendarAiRoutes } from './modules/calendar/calendar-ai'
import { registerCalendarRoutes } from './modules/calendar/calendars'
import { registerCalendarSyncRoutes } from './modules/calendar/calendar-sync.routes'
import { registerGoalRoutes } from './modules/goals/goals.routes'
import { registerGoalCalendarRoutes } from './modules/goals/goal-calendar'
import { registerOverviewRoutes } from './modules/overview/overview'
import { registerPermissionRoutes } from './modules/permissions/permissions.routes'
import { resolveCapabilities } from './platform/permissions'
import { registerAuthRoutes } from './modules/auth/auth'
import { registerOidcRoutes } from './modules/auth/oidc'
import { registerKioskRoutes } from './modules/kiosk/kiosk'
import { registerTodayLayoutRoutes } from './modules/layout/today-layout'
import { registerMobileTodayLayoutRoutes } from './modules/layout/mobile-today-layout'
import { registerPhotoRoutes } from './modules/photos/photos'
import { registerMediaRoutes } from './modules/media/media'
import { registerCaptureRoutes } from './modules/capture/capture'
import { registerWeatherRoutes } from './integrations/weather'
import { registerPowerSyncRoutes } from './modules/powersync/powersync'
import { registerPowerSyncCrudRoutes } from './modules/powersync/powersync-crud'

const api = createAPI()

// Routes that skip auth. /api/auth/keys is the JWKS PowerSync fetches; the Google
// calendar callback is hit by Google's browser redirect (no Authorization header)
// and authenticates via its one-time OAuth state instead.
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/api/auth/keys',
  '/auth/google/calendar/callback',
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
])

// Auth gate — verifies the token (sets req.principal) for every non-public route.
api.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path)) return next()
  await requireAuth(req) // throws AuthError → error handler below
  next()
})

// --- routes ---

// Liveness. Also reports which auth strategy is active, handy during the swap.
api.get('/healthz', async () => ({
  ok: true,
  service: 'nook-api',
  authMode: config.auth.mode,
}))

// Who the token says you are (no DB).
api.get('/api/me', async (req: Request) => ({ sub: req.principal?.sub }))

// Your household + person, or { provisioned: false } if you haven't onboarded yet.
api.get('/api/household', async (req: Request) => {
  const tenant = await findTenantBySub(req.principal!.sub)
  if (!tenant) return { provisioned: false }
  const { household, person } = await getContext(tenant)
  // Capabilities the client can gate UI on (admin ⇒ all; else per-role matrix).
  const capabilities = resolveCapabilities(person.member_type, person.is_admin, household.settings)
  return {
    provisioned: true,
    household: presentHousehold(household),
    person: { ...presentPerson(person), capabilities },
  }
})

// First-login provisioning: create a household with the caller as owner + admin.
api.post('/api/households', async (req: Request, res: Response) => {
  const sub = req.principal!.sub
  if (await findTenantBySub(sub)) {
    return res
      .status(409)
      .json({ error: 'Conflict', message: 'This account already has a household' })
  }

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

  const claims = req.principal!.claims
  try {
    const { household, person } = await provisionHousehold({
      sub,
      provider: inferProvider(sub),
      email: (claims.email as string | undefined) ?? null,
      emailVerified: (claims.email_verified as boolean | undefined) ?? false,
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
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res
        .status(409)
        .json({ error: 'Conflict', message: 'This account already has a household' })
    }
    throw err
  }
})

// Members CRUD (/api/persons…)
registerPersonRoutes(api)

// Lists (/api/lists…)
registerListRoutes(api)

// Chores (/api/chores…)
registerChoreRoutes(api)

// Rewards + redemptions (/api/rewards, /api/redemptions, /api/balances…)
registerRewardRoutes(api)

// Currency catalog (/api/currencies…)
registerCurrencyRoutes(api)

// Meals & recipes (/api/recipes, /api/meals…)
registerMealRoutes(api)

// Calendar events (/api/events…)
registerEventRoutes(api)

// Calendar AI cards (/api/calendar/heads-up, /api/events/:id/insight)
registerCalendarAiRoutes(api)

// Google Calendar connect (/api/calendar/google…, /auth/google/calendar/callback)
registerCalendarRoutes(api)

// Google Calendar inbound sync (/api/calendar/sync)
registerCalendarSyncRoutes(api)

// Goals (/api/goals…)
registerGoalRoutes(api)

// Calendar → goal auto-counting recap (/api/goal-calendar/recap…)
registerGoalCalendarRoutes(api)

// Built-in auth: setup / login / refresh / logout (/api/auth/*)
registerAuthRoutes(api)
registerOidcRoutes(api)

// Kiosk device pairing + profile tokens (/api/kiosk/*)
registerKioskRoutes(api)

// Person + family overviews (/api/persons/:id/overview, /api/family/overview)
registerOverviewRoutes(api)

// Role capability matrix (/api/permissions) — admin reads/edits chore+reward gates
registerPermissionRoutes(api)

// Today dashboard card layout (/api/today-layout) — family default + user override
registerTodayLayoutRoutes(api)
// Mobile Today card layout (/api/today-layout/mobile) — phone-specific config
registerMobileTodayLayoutRoutes(api)

// Photos / memories (/api/photos…)
registerPhotoRoutes(api)

// Blob upload sink (/api/media) — base64 JSON → blob store, returns key + url
registerMediaRoutes(api)

// Capture-bar LLM parsing + provider config (/api/capture…)
registerCaptureRoutes(api)

// Live weather for the kiosk topbar (/api/weather)
registerWeatherRoutes(api)

// PowerSync auth (JWKS + token endpoint)
registerPowerSyncRoutes(api)

// PowerSync offline-write upload sink (/api/powersync/crud)
registerPowerSyncCrudRoutes(api)

// Error handler — lambda-api treats a 4-arg middleware as the error sink.
api.use(
  (err: Error & { statusCode?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode ?? 500
    if (status >= 500) console.error(err)
    res.status(status).json({ error: err.name || 'Error', message: err.message })
  }
)

export default api
