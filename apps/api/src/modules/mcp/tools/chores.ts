import { createChoreFromInput, ensureTodayInstances, listTodayInstances, presentChore, requestedDate, todayDate } from '../../chores/chores.service'
import { isValidRrule } from '../../calendar/recurrence'
import type { TodayInstance } from '../../chores/chores.types'
import { defineTool, ToolInputError } from '../registry'
import { capped, DATE_SCHEMA, ID_SCHEMA, optBool, optDate, optEnum, optNumber, optString, optUuid, reqString, truncNote } from '../args'
import { DATA_NOTE, READ, WRITE } from './shared'

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

defineTool({
  name: 'create_chore',
  description:
    "Add a chore. With no personId it's up for grabs. Assigning it to someone other than the signed-in member needs a parent's permission. A one-off lands on dueOn (default today); pass rrule (e.g. FREQ=DAILY or FREQ=WEEKLY;BYDAY=MO,TH) for a recurring chore." +
    DATA_NOTE,
  scope: 'chores:write',
  module: 'chores',
  annotations: { title: 'Create a chore', ...WRITE },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      personId: { ...ID_SCHEMA, description: 'Who does it (ids from list_family); omit for up for grabs' },
      emoji: { type: 'string' },
      rewardAmount: { type: 'integer', minimum: 0, description: 'Stars earned on completion' },
      dueOn: { ...DATE_SCHEMA, description: 'One-off only: the day, YYYY-MM-DD (default today)' },
      dueTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$', description: 'HH:MM, household-local' },
      rrule: { type: 'string', description: 'RFC 5545 RRULE for a recurring chore' },
      requiresApproval: { type: 'boolean' },
      requiresPhoto: { type: 'boolean' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const rewardAmount = optNumber(args, 'rewardAmount')
    if (rewardAmount !== undefined && (!Number.isInteger(rewardAmount) || rewardAmount < 0)) {
      throw new ToolInputError('rewardAmount must be a whole number, 0 or more')
    }
    const dueTime = optString(args, 'dueTime', 5)
    if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) throw new ToolInputError('dueTime must be HH:MM')
    const rrule = optString(args, 'rrule', 200)
    if (rrule && !isValidRrule(rrule)) throw new ToolInputError('rrule is not a valid recurrence rule')
    const chore = await createChoreFromInput(tenant, {
      title: reqString(args, 'title', 200),
      personId: optUuid(args, 'personId') ?? null,
      emoji: optString(args, 'emoji', 16) ?? null,
      rewardAmount,
      dueOn: optDate(args, 'dueOn'),
      dueTime: dueTime ?? null,
      rrule: rrule ?? null,
      requiresApproval: optBool(args, 'requiresApproval'),
      requiresPhoto: optBool(args, 'requiresPhoto'),
    })
    return { data: { chore: presentChore(chore) }, summary: `Added chore "${chore.title}".`, createdId: chore.id }
  },
})
