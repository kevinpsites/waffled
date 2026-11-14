// get_today composes the other reads. It is declared family:read, so each section must
// check its own scope (and module) too — otherwise a narrow grant would read through it.
import { todayEvents } from '../../events/events'
import { todayDate } from '../../chores/chores.service'
import { weekEntries } from '../../meals/meals.service'
import { groceryBoard, householdWeekStart } from '../../lists/lists.service'
import { moduleEnabled, type ModuleKey } from '../../../platform/modules'
import { callerHas, defineTool, type ToolContext } from '../registry'
import { presentEventForAgent } from './calendar'
import { choresForDay, presentChoreForAgent } from './chores'
import { presentEntryForAgent } from './meals'
import { DATA_NOTE, READ } from './shared'

function sectionOn(ctx: ToolContext, scope: string, module?: ModuleKey): boolean {
  return callerHas(ctx, scope) && (!module || moduleEnabled(ctx.householdSettings, module))
}

defineTool({
  name: 'get_today',
  description:
    "An overview of today in the household's timezone: today's events, chores, planned meals and how many grocery items are open. A section the connection isn't allowed to read (or whose feature is turned off) is left out and named in `omitted`." +
    DATA_NOTE,
  scope: 'family:read',
  annotations: { title: "Today's overview", ...READ },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (tenant, _args, ctx) => {
    const date = todayDate(ctx.timezone)
    const data: Record<string, unknown> = { date }
    const omitted: string[] = []
    const parts: string[] = []

    if (sectionOn(ctx, 'calendar:read')) {
      const events = (await todayEvents(tenant.householdId, date, tenant.personId)).map(presentEventForAgent)
      data.events = events
      parts.push(`${events.length} event(s)`)
    } else omitted.push('events')

    if (sectionOn(ctx, 'chores:read', 'chores')) {
      const chores = (await choresForDay(tenant.householdId, date, ctx.timezone)).map(presentChoreForAgent)
      data.chores = chores
      parts.push(`${chores.filter((c) => c.status !== 'done').length} open chore(s)`)
    } else omitted.push('chores')

    if (sectionOn(ctx, 'meals:read', 'meals')) {
      const meals = (await weekEntries(tenant.householdId, date, 1)).map(presentEntryForAgent)
      data.meals = meals
      parts.push(`${meals.length} planned meal(s)`)
    } else omitted.push('meals')

    if (sectionOn(ctx, 'lists:read', 'lists')) {
      const board = await groceryBoard(tenant, await householdWeekStart(tenant.householdId))
      const open = board.items.filter((i) => !i.checked).length
      data.grocery = { listId: board.list.id, open }
      parts.push(`${open} grocery item(s) to buy`)
    } else omitted.push('grocery')

    data.omitted = omitted
    return { data, summary: `${date}: ${parts.join(', ') || 'no sections available'}.` }
  },
})
