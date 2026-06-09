// Photos / memories domain — STUB owned by the Photos agent.
// Build out the real routes (upload/list/album, kiosk screensaver feed) backed
// by a `photos` table (migration 0014). Mirror the structure of goals.ts /
// events.ts: a register function + household-scoped, soft-deleted queries.
import type createAPI from 'lambda-api'

type Api = ReturnType<typeof createAPI>

export function registerPhotoRoutes(_api: Api): void {
  // intentionally empty until the Photos slice lands
}
