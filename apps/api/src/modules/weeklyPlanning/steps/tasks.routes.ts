import type createAPI from 'lambda-api'
import type { Request } from 'lambda-api'
import { moduleRoutes, requireModule } from '../../../platform/route-guards'
import { resolveWeekStart } from '../weeklyPlanning'
import { getTasksBoard } from './tasks'

type Api = ReturnType<typeof createAPI>

// Step 8 · Tasks — the one read this step needs over chores. Read-only on purpose:
// handing a chore out goes through the existing chores endpoints, and this step stores
// nothing of its own.
const { tenantRoute } = moduleRoutes('weeklyPlanning')

export function registerTasksStepRoutes(api: Api): void {
  // A column per member plus everything up for grabs. Asserts `chores` to match the
  // catalog's `requiresModule`, and `?weekStart=` goes through the shell's own
  // `resolveWeekStart` so the boundary stays server-owned.
  api.get('/api/weekly-planning/tasks', tenantRoute(async (tenant, req: Request) => {
    await requireModule(tenant, 'chores')
    const weekStart = await resolveWeekStart(tenant.householdId, req.query?.weekStart)
    return getTasksBoard(tenant.householdId, weekStart)
  }))
}
