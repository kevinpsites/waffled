// Validate client-supplied foreign keys before persisting them. UUID foreign keys
// alone do not enforce tenant ownership, so every write path must prove both the
// referenced row and the current household. A 404 avoids confirming foreign rows.
import { query } from './db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidReferenceError extends Error {
  statusCode = 400

  constructor(message = 'invalid referenced resource id') {
    super(message)
    this.name = 'BadRequest'
  }
}

export class HouseholdReferenceError extends Error {
  statusCode = 404

  constructor(message = 'referenced resource not found') {
    super(message)
    this.name = 'NotFound'
  }
}

export async function assertPersonsInHousehold(householdId: string, personIds: readonly string[]): Promise<void> {
  const ids = [...new Set(personIds)]
  if (ids.length === 0) return
  if (ids.some((id) => !UUID_RE.test(id))) throw new InvalidReferenceError('invalid person id')
  const { rows } = await query<{ id: string }>(
    `select id from persons
      where household_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [householdId, ids]
  )
  if (rows.length !== ids.length) throw new HouseholdReferenceError('person not found')
}

export async function assertPersonInHousehold(householdId: string, personId: string): Promise<void> {
  await assertPersonsInHousehold(householdId, [personId])
}

async function assertHouseholdRow(
  table: 'goals' | 'goal_lists' | 'calendars' | 'recipes' | 'lists' | 'events',
  householdId: string,
  id: string,
  label: string
): Promise<void> {
  if (!UUID_RE.test(id)) throw new InvalidReferenceError(`invalid ${label} id`)
  // `table` is an internal closed union above; all request-derived values stay parameterized.
  const { rowCount } = await query(
    `select 1 from ${table} where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  if (!rowCount) throw new HouseholdReferenceError(`${label} not found`)
}

export const assertGoalInHousehold = (householdId: string, goalId: string) =>
  assertHouseholdRow('goals', householdId, goalId, 'goal')

export const assertGoalListInHousehold = (householdId: string, goalListId: string) =>
  assertHouseholdRow('goal_lists', householdId, goalListId, 'goal list')

export const assertCalendarInHousehold = (householdId: string, calendarId: string) =>
  assertHouseholdRow('calendars', householdId, calendarId, 'calendar')

export const assertRecipeInHousehold = (householdId: string, recipeId: string) =>
  assertHouseholdRow('recipes', householdId, recipeId, 'recipe')

export const assertListInHousehold = (householdId: string, listId: string) =>
  assertHouseholdRow('lists', householdId, listId, 'list')

export const assertEventInHousehold = (householdId: string, eventId: string) =>
  assertHouseholdRow('events', householdId, eventId, 'event')

export async function assertGoalStepInHousehold(
  householdId: string,
  stepId: string,
  goalId?: string | null
): Promise<void> {
  if (!UUID_RE.test(stepId)) throw new InvalidReferenceError('invalid goal step id')
  if (goalId != null && !UUID_RE.test(goalId)) throw new InvalidReferenceError('invalid goal id')
  const { rowCount } = await query(
    `select 1 from goal_steps
      where household_id = $1 and id = $2 and deleted_at is null
        and ($3::uuid is null or goal_id = $3)`,
    [householdId, stepId, goalId ?? null]
  )
  if (!rowCount) throw new HouseholdReferenceError('goal step not found')
}
