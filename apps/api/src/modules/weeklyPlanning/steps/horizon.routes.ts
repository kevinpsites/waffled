import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes } from '../../../platform/route-guards'
import { getHorizon } from './horizon'

type Api = ReturnType<typeof createAPI>

// Step 3 · Horizon scan — ONE route, and deliberately not three. The month itself is the
// plain calendar (`GET /api/events?from&to`, `POST /api/events`), and PARKING is a POST to
// step 1's `/api/weekly-planning/loose-ends/parked`, which was written general enough that
// this step needs neither a migration nor a second writer — a `/horizon/park` alias would
// be a second, subtly different parked-item path. What is left is the read the park bar
// can't derive: the tags it may offer, and what this session has already parked.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerHorizonStepRoutes(api: Api): void {
  api.get('/api/weekly-planning/horizon', tenantRoute(async (tenant, req: Request) =>
    getHorizon(tenant.householdId, req.query?.sessionId ?? null)
  ))
}
