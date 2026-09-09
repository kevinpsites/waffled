import type createAPI from 'lambda-api'
import type { Request, Response } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { resolveWeekStart, getSessionById } from '../weeklyPlanning'
import { getKidsStepView, answerKid, repeatLastWeek } from './kids'

type Api = ReturnType<typeof createAPI>

// Step 9 · Kids — the reads this step needs over goals and chores, plus the two answers it
// records. Service logic and its reasoning live in ./kids.ts.
//
// GATED ONCE, not twice: this step has NO `requiresModule` because it reads goals AND chores
// and a household toggles those separately — gating on either would delete the step for a
// family that runs the other. The service contributes nothing per-source when a module is off.
//
// WHICH WEEK: when a session is named, its OWN `week_start` decides, or a client that forgot
// to echo `weekStart` gets a different week's events and is told its real pick isn't an
// option. `?weekStart=` resolves the sessionless read through the shell's resolveWeekStart.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)

export function registerKidsStepRoutes(api: Api): void {
  // The whole read: a card per child, with their week, their stars, and both option sets.
  api.get('/api/weekly-planning/kids', tenantRoute(async (tenant, req: Request) => {
    const sessionId = uuidOrNull(req.query?.sessionId)
    const session = sessionId ? await getSessionById(tenant.householdId, sessionId) : null
    const weekStart = session?.weekStart ?? (await resolveWeekStart(tenant.householdId, req.query?.weekStart))
    return getKidsStepView(tenant, weekStart, session ? sessionId : null)
  }))

  // Answer one card. Each question is sent on its own (`null` clears, an omitted key leaves
  // it alone). A REAL write, not `setDecisionData`: the frame is what the kids remember.
  api.put('/api/weekly-planning/kids/answer', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await answerKid(tenant, body)
    if (!result.ok) return res.status(result.status).json({ error: result.status === 404 ? 'NotFound' : 'BadRequest', message: result.message })
    return res.status(200).json(result.view)
  }))

  // "Same as last week" — copy the previous answers forward, keeping only those whose
  // referent still stands. Additive: it never clears an answer already given.
  api.post('/api/weekly-planning/kids/repeat', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await repeatLastWeek(tenant, body.sessionId)
    if (!result.ok) return res.status(result.status).json({ error: 'NotFound', message: result.message })
    return res.status(200).json(result.view)
  }))
}
