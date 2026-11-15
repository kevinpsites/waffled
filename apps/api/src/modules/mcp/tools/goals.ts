import type { Tenant } from '../../households/households'
import { goalDisplay, listGoals, visibleGoalLists } from '../../goals/goals.service'
import { defineTool } from '../registry'
import { capped, ID_SCHEMA, optUuid, truncNote } from '../args'
import { DATA_NOTE, READ } from './shared'

const MAX_GOALS = 200

// The caller's goals: shared lists, unlisted goals, and private lists they belong to.
export async function goalsVisibleTo(tenant: Tenant) {
  const [lists, goals] = await Promise.all([visibleGoalLists(tenant), listGoals(tenant.householdId)])
  const visible = new Set(lists.map((l) => l.id))
  return goals.filter((g) => g.goalListId == null || visible.has(g.goalListId))
}

defineTool({
  name: 'list_goals',
  description:
    "The family's goals with progress. progress.axis says what the numbers count: 'period' = completions this day/week/month (habits), 'steps' = checklist steps done, 'lifetime' = the running total. Goal ids work with log_goal." +
    DATA_NOTE,
  scope: 'goals:read',
  module: 'goals',
  annotations: { title: 'List goals', ...READ },
  inputSchema: {
    type: 'object',
    properties: { personId: { ...ID_SCHEMA, description: 'Only goals this member takes part in' } },
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const personId = optUuid(args, 'personId')
    const goals = (await goalsVisibleTo(tenant)).filter(
      (g) => !personId || g.participants.some((p: { personId: string }) => p.personId === personId)
    )
    const c = capped(
      goals.map((g) => ({
        id: g.id,
        title: g.title,
        emoji: g.emoji,
        goalType: g.goalType,
        unit: g.unit,
        progress: goalDisplay(g),
        streakDays: g.streakDays,
        deadline: g.deadline,
        participants: g.participants.map((p: { personId: string; name?: string }) => ({ id: p.personId, name: p.name ?? null })),
      })),
      MAX_GOALS
    )
    return { data: c, summary: `${c.total} goal(s)${truncNote(c)}.` }
  },
})
