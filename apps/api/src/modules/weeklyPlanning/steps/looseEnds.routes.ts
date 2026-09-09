import type createAPI from 'lambda-api'
import type { Request, Response } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { resolveWeekStart, getSessionById } from '../weeklyPlanning'
import { getLooseEnds, parkItem, resolveLooseEnd, routeLooseEnd, updateParkedItem } from './looseEnds'

type Api = ReturnType<typeof createAPI>

// Step 1 · Loose ends — the reads over chores, lists, rhythms and goals, plus the one table
// it owns (planning_parked_items).
//
// Four routes and no more. The step is INTAKE: `route` writes nothing to any module and
// only records — on the session — which step will handle the item. `resolve` is the two
// exceptions ("It's done already", and "Drop it" on a parked note); `parked` is the capture
// bar. There is deliberately no per-item "seen it" route: leaving something open writes
// nothing.
//
// Registered from ./index.ts. Every route is behind the module gate; the resolve path
// checks the SOURCE module's own toggle as well (see resolveLooseEnd).
const { tenantRoute } = moduleRoutes('weeklyPlanning')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)

export function registerLooseEndsStepRoutes(api: Api): void {
  // Both groups for the week being planned, the destinations each group can send an item
  // to, and what this session has routed so far. `?weekStart=` goes through the module's
  // one gate (snapped to a household week start, floored at the current week).
  // `?sessionId=` is what makes the read self-contained, which is far easier to reason
  // about and to test.
  api.get('/api/weekly-planning/loose-ends', tenantRoute(async (tenant, req: Request) => {
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    // HOUSEHOLD-SCOPED. `?sessionId=` must be checked against this household before it
    // reaches `listRoutes`, which selects from `planning_session_steps` by `session_id`
    // alone — that table has no `household_id` of its own, it is scoped only through
    // `planning_sessions`. Unchecked, another household's id reads THEIR routes, and every
    // entry carries a `title`.
    //
    // Resolved through `getSessionById` exactly as the recap, kids and goals reads do: an
    // id that is not ours resolves to NO session, and the step answers for the week with no
    // routes rather than refusing (a malformed id would otherwise 500 on `uuid = 'nope'`).
    const asked = uuidOrNull(req.query?.sessionId)
    const session = asked ? await getSessionById(tenant.householdId, asked) : null
    return getLooseEnds(tenant.householdId, weekStart, session ? asked : null)
  }))

  // THE STEP'S MAIN VERB. Send an item to the step that will handle it — or `to: null` to
  // undo. Routing changes nothing in any module; the decision lives in
  // planning_session_steps.data.routes for the `looseEnds` step.
  api.post('/api/weekly-planning/loose-ends/route', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await routeLooseEnd(tenant, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return { routes: result.routes }
  }))

  // The two answers that DO write: `done` on any kind, and `drop` on a parked note only —
  // dropping a computed item would mean deleting another module's data.
  api.post('/api/weekly-planning/loose-ends/resolve', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await resolveLooseEnd(tenant, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return result
  }))

  // The capture bar under group B. Step 3 ("Horizon scan") parks here too, from the month
  // view; the route and the table are general on purpose, so it needs no migration.
  api.post('/api/weekly-planning/loose-ends/parked', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await parkItem(tenant, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return { item: result.item }
  }))

  // FIX WHAT YOU JUST WROTE. A typo, or the wrong tag chip, is repairable in place; Drop is
  // reserved for "it was never really a thing". Both fields are read for PRESENCE, so an
  // omitted key leaves that half alone while `stepKey: null` is the real answer "No tag".
  //
  // `routes` comes back only when a `sessionId` was sent: re-tagging a note that step 1
  // ROUTED has to move its trail entry too, or the badge and the trail disagree.
  api.patch('/api/weekly-planning/loose-ends/parked/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const result = await updateParkedItem(tenant, req.params.id, (req.body ?? {}) as Record<string, unknown>)
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message })
    return { item: result.item, ...(result.routes ? { routes: result.routes } : {}) }
  }))
}
