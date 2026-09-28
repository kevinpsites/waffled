import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { requireCapability } from '../../../platform/permissions'
import { assertPersonInHousehold } from '../../../platform/household-refs'
import { resolveWeekStart } from '../weeklyPlanning'
import { mealsStepView, fillEmptyDinners, undoFilledDinners, parseFilledNights, parsePlanCards, setShoppingTrip } from './meals'

type Api = ReturnType<typeof createAPI>

// Step 7 · Meals — the reads and the two writes this step needs over the meal plan.
//
// Registered from ./index.ts, so weeklyPlanning.routes.ts is never edited. Gated on
// `weeklyPlanning` AND asserting `meals` inside, because that is the module these routes
// read and the catalog already marks the step unavailable without it.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerMealsStepRoutes(api: Api): void {
  // THE WEEK IS THE SERVER'S: `resolveWeekStart` rejects nonsense, snaps a mid-week date
  // and clamps to the floor. A client-computed week writes rows onto a key nothing reads.
  api.get('/api/weekly-planning/meals', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    // `choreId` is a hint, never a requirement: without it the trip is found by
    // title + week.
    const hint = typeof req.query?.choreId === 'string' ? req.query.choreId : null
    return mealsStepView(tenant, weekStart, hint)
  }))

  // Fills ONLY the nights with no dinner and hands back what it wrote, so the footer slot
  // can become "Undo the three". `cards` is the week the family approved in the shared
  // planner; it comes through here rather than POST /api/meals/plan because that route
  // will touch a decided night and returns no receipt for the undo.
  api.post('/api/weekly-planning/meals/fill', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const body = (req.body ?? {}) as { weekStart?: unknown; cards?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, body.weekStart)
    // Provided-but-unusable is NOT absent: a wrongly shaped `cards` writes nothing, never
    // a week the family never approved.
    const cards = body.cards === undefined ? null : (parsePlanCards(body.cards) ?? [])
    return fillEmptyDinners(tenant, weekStart, cards)
  }))

  // Takes back what the fill wrote and nothing else: a night since decided by hand is
  // reported in `kept`, never cleared.
  api.post('/api/weekly-planning/meals/undo', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    const body = (req.body ?? {}) as { weekStart?: unknown; filled?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, body.weekStart)
    return undoFilledDinners(tenant, weekStart, parseFilledNights(body.filled))
  }))

  // The trip is a real one-off chore, kept to ONE per week (see `setShoppingTrip`), so
  // this is gated on `chores` as well as `meals`.
  //
  // Permissions follow the chores module's own rule: handing the trip to somebody ELSE
  // (or taking it off them) is `chore.manage`; putting it on yourself is not.
  api.put('/api/weekly-planning/meals/shopper', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'meals')
    await requireModule(tenant, 'chores')
    const b = (req.body ?? {}) as { weekStart?: unknown; dueOn?: unknown; personId?: unknown; dueTime?: unknown; choreId?: unknown }
    const weekStart = await resolveWeekStart(tenant.householdId, b.weekStart)

    const personId = typeof b.personId === 'string' && b.personId ? b.personId : null
    if (personId) await assertPersonInHousehold(tenant.householdId, personId)
    if (personId !== null && personId !== tenant.personId) await requireCapability(tenant, 'chore.manage')

    return setShoppingTrip(tenant, weekStart, {
      dueOn: typeof b.dueOn === 'string' && b.dueOn ? b.dueOn : null,
      personId,
      dueTime: typeof b.dueTime === 'string' && /^\d{2}:\d{2}$/.test(b.dueTime) ? b.dueTime : null,
      choreId: typeof b.choreId === 'string' ? b.choreId : null,
    })
  }))
}
