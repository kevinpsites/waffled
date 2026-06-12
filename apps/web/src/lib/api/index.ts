// Barrel for the api client. Each domain lives in its own module so screens (and
// the agents that build them) own one file outright; this file just re-exports
// the slices and composes the flat `api` object consumers call.
//
// Adding a domain: create ./<domain>.ts exporting `<domain>Api` + types/hooks,
// then add one `export * from` line and one spread below. That's the only shared
// touch — keep it append-only.
export { localToday } from './client'
export * from './bus'
export * from './persons'
export * from './goals'
export * from './overview'
export * from './grocery'
export * from './chores'
export * from './rewards'
export * from './events'
export * from './meals'
export * from './photos'
export * from './capture'

import { personsApi } from './persons'
import { goalsApi } from './goals'
import { groceryApi } from './grocery'
import { choresApi } from './chores'
import { rewardsApi } from './rewards'
import { eventsApi } from './events'
import { mealsApi } from './meals'
import { photosApi } from './photos'
import { captureApi } from './capture'

export const api = {
  ...personsApi,
  ...goalsApi,
  ...groceryApi,
  ...choresApi,
  ...rewardsApi,
  ...eventsApi,
  ...mealsApi,
  ...photosApi,
  ...captureApi,
}
