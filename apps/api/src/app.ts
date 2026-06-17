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
import { registerMealRoutes } from './modules/meals/meals.routes'
import { registerEventRoutes } from './modules/events/events'
import { registerCalendarAiRoutes } from './modules/calendar/calendar-ai'
import { registerCalendarRoutes } from './modules/calendar/calendars'
import { registerCalendarSyncRoutes } from './modules/calendar/calendar-sync.routes'
import { registerGoalRoutes } from './modules/goals/goals.routes'
import { registerOverviewRoutes } from './modules/overview/overview'
import { registerPhotoRoutes } from './modules/photos/photos'
import { registerCaptureRoutes } from './modules/capture/capture'
import { registerWeatherRoutes } from './integrations/weather'
import { registerPowerSyncRoutes } from './modules/powersync/powersync'
import { registerPowerSyncCrudRoutes } from './modules/powersync/powersync-crud'

const api = createAPI()

// Routes that skip auth. /api/auth/keys is the JWKS PowerSync fetches; the Google
// calendar callback is hit by Google's browser redirect (no Authorization header)
// and authenticates via its one-time OAuth state instead.
const PUBLIC_PATHS = new Set(['/healthz', '/api/auth/keys', '/auth/google/calendar/callback'])

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
  return {
    provisioned: true,
    household: presentHousehold(household),
    person: presentPerson(person),
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

// Person + family overviews (/api/persons/:id/overview, /api/family/overview)
registerOverviewRoutes(api)

// Photos / memories (/api/photos…)
registerPhotoRoutes(api)

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
