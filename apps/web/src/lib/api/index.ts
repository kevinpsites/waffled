// Barrel for the api client. Each domain lives in its own module so screens (and
// the agents that build them) own one file outright; this file just re-exports
// the slices and composes the flat `api` object consumers call.
//
// Adding a domain: create ./<domain>.ts exporting `<domain>Api` + types/hooks,
// then add one `export * from` line and one spread below. That's the only shared
// touch — keep it append-only.
export { localToday } from './client'
export * from './persons'
export * from './goals'
export * from './grocery'
export * from './chores'
export * from './events'
export * from './meals'
export * from './photos'

import { personsApi } from './persons'
import { goalsApi } from './goals'
import { groceryApi } from './grocery'
import { choresApi } from './chores'
import { eventsApi } from './events'
import { mealsApi } from './meals'
import { photosApi } from './photos'

export const api = {
  ...personsApi,
  ...goalsApi,
  ...groceryApi,
  ...choresApi,
  ...eventsApi,
  ...mealsApi,
  ...photosApi,
}
