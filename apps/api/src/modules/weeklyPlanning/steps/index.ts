import type createAPI from 'lambda-api'
import { registerLooseEndsStepRoutes } from './looseEnds.routes'
import { registerCalendarStepRoutes } from './calendar.routes'
import { registerHorizonStepRoutes } from './horizon.routes'
import { registerFamilyNightStepRoutes } from './familyNight.routes'
import { registerConnectionStepRoutes } from './connection.routes'
import { registerGoalsStepRoutes } from './goals.routes'
import { registerMealsStepRoutes } from './meals.routes'
import { registerTasksStepRoutes } from './tasks.routes'
import { registerKidsStepRoutes } from './kids.routes'
import { registerRecapStepRoutes } from './recap.routes'

type Api = ReturnType<typeof createAPI>

// Every step's routes, pre-registered, so building a step never means editing
// weeklyPlanning.routes.ts — ten steps built in parallel would collide on that one file.
export const STEP_ROUTE_REGISTRARS: ((api: Api) => void)[] = [
  registerLooseEndsStepRoutes,
  registerCalendarStepRoutes,
  registerHorizonStepRoutes,
  registerFamilyNightStepRoutes,
  registerConnectionStepRoutes,
  registerGoalsStepRoutes,
  registerMealsStepRoutes,
  registerTasksStepRoutes,
  registerKidsStepRoutes,
  registerRecapStepRoutes,
]
