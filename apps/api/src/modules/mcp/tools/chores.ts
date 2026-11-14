import { ensureTodayInstances, listTodayInstances, requestedDate, todayDate } from '../../chores/chores.service'
import type { TodayInstance } from '../../chores/chores.types'
import { defineTool, ToolInputError } from '../registry'
import { capped, DATE_SCHEMA, ID_SCHEMA, optDate, optEnum, optUuid, truncNote } from '../args'
import { DATA_NOTE, READ } from './shared'

const STATUSES = ['pending', 'awaiting', 'done'] as const
const MAX_CHORES = 200

export function presentChoreForAgent(i: TodayInstance) {
  return {
    id: i.id,
    choreId: i.choreId,
    title: i.choreTitle,
    status: i.status,
    person: i.personId ? { id: i.personId, name: i.personName } : null,
    dueOn: i.dueOn,
    dueTime: i.dueTime,
    reward: i.rewardAmount ? { amount: i.rewardAmount, currency: i.rewardCurrency } : null,
    recurring: i.rrule != null,
    requiresPhoto: i.requiresPhoto,
  }
}

// A day's chore instances, materializing recurring ones first (as the Tasks screen does).
export async function choresForDay(householdId: string, date: string, tz: string, personId?: string): Promise<TodayInstance[]> {
  await ensureTodayInstances(householdId, date)
  return listTodayInstances(householdId, date, tz, { streaks: false, personId })
}

defineTool({
  name: 'list_chores',
  description:
    "Chores for one day (default today, household-local; within 31 days). status: pending (open), awaiting (submitted, needs a parent's OK) or done. A chore with no person is up for grabs. Ids work with complete_chore / reassign_chore." +
    DATA_NOTE,
  scope: 'chores:read',
  module: 'chores',
  annotations: { title: 'List chores', ...READ },
  inputSchema: {
    type: 'object',
    properties: {
      date: { ...DATE_SCHEMA, description: 'Day, YYYY-MM-DD (default today)' },
      status: { type: 'string', enum: [...STATUSES] },
      personId: { ...ID_SCHEMA, description: 'Only this member (ids from list_family)' },
    },
    additionalProperties: false,
  },
  run: async (tenant, args, ctx) => {
    const today = todayDate(ctx.timezone)
    const asked = optDate(args, 'date')
    const date = requestedDate(asked, today)
    if (asked && asked !== date) throw new ToolInputError('date must be within 31 days of today')
    const status = optEnum(args, 'status', STATUSES)
    const rows = await choresForDay(tenant.householdId, date, ctx.timezone, optUuid(args, 'personId'))
    const c = capped(rows.filter((i) => !status || i.status === status).map(presentChoreForAgent), MAX_CHORES)
    return { data: { date, ...c }, summary: `${c.total} chore(s) on ${date}${truncNote(c)}.` }
  },
})
