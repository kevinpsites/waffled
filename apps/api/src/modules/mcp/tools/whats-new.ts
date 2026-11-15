// whats_new(since): what changed in the household, for agents that poll (mcp-plan.md §6,
// tier A). Derived from existing timestamps (created_at / updated_at / deleted_at,
// completed_at, checked_at), so it reports current state: an edit shows as "updated" without
// what changed, and a hard delete is invisible. Each section reuses its module's read rule:
// visibleTo for personal events, goalsVisibleTo for private goal lists, soft deletes.
import { visibleTo } from '../../events/events'
import { goalDisplay } from '../../goals/goals.service'
import { query } from '../../../platform/db'
import { defineTool, sectionOn, ToolInputError, type ToolContext } from '../registry'
import { clip } from '../args'
import { goalsVisibleTo } from './goals'
import { DATA_NOTE, READ } from './shared'
import type { Tenant } from '../../households/households'

const MAX_ITEMS = 200
const MAX_DAYS_BACK = 14
const CLOCK_SKEW_MS = 60_000
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

interface Who {
  id: string
  name: string | null
}

interface Change {
  kind: string
  at: string
  who: Who | null
  title: string
  ids: Record<string, string>
  [extra: string]: unknown
}

const iso = (d: Date | string) => new Date(d).toISOString()
const who = (id: string | null, name: string | null): Who | null => (id ? { id, name } : null)
const title = (s: string | null | undefined, fallback: string) => clip(s, 200) ?? fallback

interface Section {
  name: string
  scope: string
  module?: 'chores' | 'lists' | 'goals' | 'meals' | 'rewards'
  read: (tenant: Tenant, since: string, limit: number) => Promise<Change[]>
}

const SECTIONS: Section[] = [
  {
    name: 'events',
    scope: 'calendar:read',
    read: async (tenant, since, limit) => {
      // One item per event, at its latest change; a deletion or a synced cancellation wins.
      const { rows } = await query<{
        id: string; title: string; starts_at: Date; all_day: boolean; person_id: string | null; person_name: string | null
        created_at: Date; deleted_at: Date | null; status: string | null; at: Date
      }>(
        `select e.id, e.title, e.starts_at, e.all_day, e.person_id, p.name as person_name,
                e.created_at, e.deleted_at, e.status,
                greatest(e.created_at, e.updated_at, coalesce(e.deleted_at, '-infinity')) as at
           from events e
           left join persons p on p.id = e.person_id
          where e.household_id = $1 ${visibleTo('e', '$3')} and (e.deleted_at is null or e.deleted_at > $2)
            and greatest(e.created_at, e.updated_at, coalesce(e.deleted_at, '-infinity')) > $2
          order by at limit $4`,
        [tenant.householdId, since, tenant.personId, limit]
      )
      const overrides = await query<{ id: string; event_id: string; title: string; original_start: Date; is_cancelled: boolean; at: Date }>(
        `select ov.id, ov.event_id, coalesce(ov.title, m.title) as title, ov.original_start, ov.is_cancelled,
                greatest(ov.created_at, ov.updated_at) as at
           from event_overrides ov
           join events m on m.id = ov.event_id and m.deleted_at is null
          where ov.household_id = $1 and ov.deleted_at is null ${visibleTo('m', '$3')}
            and greatest(ov.created_at, ov.updated_at) > $2
          order by at limit $4`,
        [tenant.householdId, since, tenant.personId, limit]
      )
      const sinceMs = Date.parse(since)
      return [
        ...rows.map((r) => ({
          kind:
            (r.deleted_at && r.deleted_at.getTime() > sinceMs) || r.status === 'cancelled'
              ? 'event_cancelled'
              : r.created_at.getTime() > sinceMs
                ? 'event_added'
                : 'event_updated',
          at: iso(r.at),
          who: null,
          title: title(r.title, 'Event'),
          ids: { eventId: r.id },
          startsAt: iso(r.starts_at),
          allDay: r.all_day,
          person: who(r.person_id, r.person_name),
        })),
        ...overrides.rows.map((r) => ({
          kind: r.is_cancelled ? 'occurrence_cancelled' : 'occurrence_changed',
          at: iso(r.at),
          who: null,
          title: title(r.title, 'Event'),
          ids: { eventId: r.event_id },
          occurrenceStart: iso(r.original_start),
        })),
      ]
    },
  },
  {
    name: 'chores',
    scope: 'chores:read',
    module: 'chores',
    read: async (tenant, since, limit) => {
      const done = await query<{ id: string; chore_id: string; title: string; at: Date; due_on: string; by: string | null; by_name: string | null; approval_status: string | null }>(
        `select ci.id, ci.chore_id, c.title, ci.completed_at as at, to_char(ci.due_on, 'YYYY-MM-DD') as due_on,
                ci.completed_by as by, p.name as by_name, ci.approval_status
           from chore_instances ci
           join chores c on c.id = ci.chore_id
           left join persons p on p.id = ci.completed_by
          where ci.household_id = $1 and ci.deleted_at is null and ci.completed_at > $2
          order by ci.completed_at limit $3`,
        [tenant.householdId, since, limit]
      )
      const added = await query<{ id: string; title: string; at: Date; person_id: string | null; person_name: string | null; rrule: string | null }>(
        `select c.id, c.title, c.created_at as at, c.person_id, p.name as person_name, c.rrule
           from chores c
           left join persons p on p.id = c.person_id
          where c.household_id = $1 and c.deleted_at is null and c.created_at > $2
          order by c.created_at limit $3`,
        [tenant.householdId, since, limit]
      )
      return [
        ...done.rows.map((r) => ({
          kind: 'chore_completed',
          at: iso(r.at),
          who: who(r.by, r.by_name),
          title: title(r.title, 'Chore'),
          ids: { choreId: r.chore_id, instanceId: r.id },
          dueOn: r.due_on,
          awaitingApproval: r.approval_status === 'pending',
        })),
        ...added.rows.map((r) => ({
          kind: 'chore_added',
          at: iso(r.at),
          who: null,
          title: title(r.title, 'Chore'),
          ids: { choreId: r.id },
          assignee: who(r.person_id, r.person_name),
          recurring: r.rrule != null,
        })),
      ]
    },
  },
  {
    name: 'lists',
    scope: 'lists:read',
    module: 'lists',
    read: async (tenant, since, limit) => {
      // Rows the meal plan generates ('auto') are rebuilt wholesale, so their adds and
      // removals are noise; the meals section reports the plan change behind them.
      const { rows } = await query<{ kind: string; id: string; list_id: string; list_name: string; title: string; at: Date; by: string | null; by_name: string | null }>(
        `with li as (
           select li.*, l.name as list_name
             from list_items li
             join lists l on l.id = li.list_id and l.deleted_at is null and l.list_type <> 'template'
            where li.household_id = $1 and li.status = 'active'
         )
         select x.*, p.name as by_name from (
           select 'list_item_added' as kind, id, list_id, list_name, name as title, created_at as at, created_by as by
             from li where created_at > $2 and source <> 'auto'
           union all
           select 'list_item_checked', id, list_id, list_name, name, checked_at, checked_by
             from li where checked and checked_at > $2 and deleted_at is null
           union all
           select 'list_item_removed', id, list_id, list_name, name, deleted_at, null
             from li where deleted_at > $2 and source <> 'auto'
         ) x
         left join persons p on p.id = x.by
         order by x.at limit $3`,
        [tenant.householdId, since, limit]
      )
      return rows.map((r) => ({
        kind: r.kind,
        at: iso(r.at),
        who: who(r.by, r.by_name),
        title: title(r.title, 'Item'),
        ids: { itemId: r.id, listId: r.list_id },
        list: clip(r.list_name, 100),
      }))
    },
  },
  {
    name: 'goals',
    scope: 'goals:read',
    module: 'goals',
    read: async (tenant, since, limit) => {
      const goals = new Map((await goalsVisibleTo(tenant)).map((g) => [g.id, g]))
      if (!goals.size) return []
      const { rows } = await query<{ id: string; goal_id: string; amount: number; at: Date; by: string | null; by_name: string | null }>(
        `select gl.id, gl.goal_id, gl.amount::float as amount, gl.created_at as at,
                coalesce(gl.person_id, gl.created_by) as by, p.name as by_name
           from goal_logs gl
           left join persons p on p.id = coalesce(gl.person_id, gl.created_by)
          where gl.household_id = $1 and gl.deleted_at is null and gl.created_at > $2 and gl.goal_id = any($3::uuid[])
          order by gl.created_at limit $4`,
        [tenant.householdId, since, [...goals.keys()], limit]
      )
      return rows.map((r) => {
        const g = goals.get(r.goal_id)!
        return {
          kind: 'goal_logged',
          at: iso(r.at),
          who: who(r.by, r.by_name),
          title: title(g.title, 'Goal'),
          ids: { goalId: g.id, logId: r.id },
          amount: r.amount,
          unit: g.unit ?? null,
          progress: goalDisplay(g),
        }
      })
    },
  },
  {
    name: 'rewards',
    scope: 'rewards:read',
    module: 'rewards',
    read: async (tenant, since, limit) => {
      const { rows } = await query<{ id: string; person_id: string; name: string | null; amount: number; currency: string; reason: string; note: string | null; at: Date }>(
        `select le.id, le.person_id, p.name, le.amount, le.currency, le.reason, le.note, le.created_at as at
           from ledger_entries le
           left join persons p on p.id = le.person_id
          where le.household_id = $1 and le.deleted_at is null and le.created_at > $2
          order by le.created_at limit $3`,
        [tenant.householdId, since, limit]
      )
      return rows.map((r) => ({
        kind: r.amount >= 0 ? 'reward_earned' : 'reward_spent',
        at: iso(r.at),
        who: who(r.person_id, r.name),
        title: title(r.note, r.reason.replace(/_/g, ' ')),
        ids: { entryId: r.id },
        amount: r.amount,
        currency: r.currency,
        reason: r.reason,
      }))
    },
  },
  {
    name: 'meals',
    scope: 'meals:read',
    module: 'meals',
    read: async (tenant, since, limit) => {
      const { rows } = await query<{ id: string; date: string; meal_type: string; title: string | null; recipe_id: string | null; created_at: Date; deleted_at: Date | null; at: Date }>(
        `select mpe.id, to_char(mpe.date, 'YYYY-MM-DD') as date, mpe.meal_type,
                coalesce(r.title, ml.name, mpe.title) as title, mpe.recipe_id, mpe.created_at, mpe.deleted_at,
                greatest(mpe.created_at, mpe.updated_at, coalesce(mpe.deleted_at, '-infinity')) as at
           from meal_plan_entries mpe
           left join recipes r on r.id = mpe.recipe_id
           left join meals ml on ml.id = mpe.meal_id
          where mpe.household_id = $1 and (mpe.deleted_at is null or mpe.deleted_at > $2)
            and greatest(mpe.created_at, mpe.updated_at, coalesce(mpe.deleted_at, '-infinity')) > $2
          order by at limit $3`,
        [tenant.householdId, since, limit]
      )
      const sinceMs = Date.parse(since)
      return rows.map((r) => ({
        kind: r.deleted_at ? 'meal_removed' : r.created_at.getTime() > sinceMs ? 'meal_planned' : 'meal_changed',
        at: iso(r.at),
        who: null,
        title: title(r.title, 'Meal'),
        ids: { entryId: r.id, ...(r.recipe_id ? { recipeId: r.recipe_id } : {}) },
        date: r.date,
        mealType: r.meal_type,
      }))
    },
  },
]

function readSince(args: Record<string, unknown>): string {
  const v = args.since
  if (typeof v !== 'string' || !DATETIME_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ToolInputError('since is required: an ISO timestamp with an offset, like 2026-11-14T08:00:00Z')
  }
  const t = Date.parse(v)
  if (t > Date.now() + CLOCK_SKEW_MS) throw new ToolInputError('since must not be in the future')
  if (Date.now() - t > MAX_DAYS_BACK * 86_400_000) throw new ToolInputError(`since must be within the last ${MAX_DAYS_BACK} days`)
  return new Date(t).toISOString()
}

defineTool({
  name: 'whats_new',
  description:
    "What changed in the household since a time (at most 14 days back): events added, changed or cancelled; chores completed (and by whom) or added; list items added, checked off or removed; goal progress logged; stars earned or spent; meal plan changes. Oldest first. Built for checking in periodically: pass the previous call's `until` (or `nextSince` when the result was cut) as the next `since`. A section the connection isn't allowed to read, or whose feature is off, is left out and named in `omitted`." +
    DATA_NOTE,
  scope: 'family:read',
  annotations: { title: "What's new", ...READ },
  inputSchema: {
    type: 'object',
    properties: { since: { type: 'string', format: 'date-time', description: 'ISO timestamp with an offset; at most 14 days ago' } },
    required: ['since'],
    additionalProperties: false,
  },
  run: async (tenant, args, ctx: ToolContext) => {
    const since = readSince(args)
    const until = new Date().toISOString()
    const sections: string[] = []
    const omitted: string[] = []
    const all: Change[] = []
    // One past the cap per section: a section's own cut is then visible, and the merged
    // oldest-first cut stays exact, since no section dropped anything older than the cap.
    for (const s of SECTIONS) {
      if (!sectionOn(ctx, s.scope, s.module)) {
        omitted.push(s.name)
        continue
      }
      sections.push(s.name)
      all.push(...(await s.read(tenant, since, MAX_ITEMS + 1)))
    }
    all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const items = all.slice(0, MAX_ITEMS)
    const truncated = all.length > MAX_ITEMS
    const nextSince = truncated ? items[items.length - 1].at : undefined

    const counts = new Map<string, number>()
    for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1)
    const tally = [...counts].map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')
    return {
      data: { since, until, sections, omitted, items, truncated, ...(nextSince ? { nextSince } : {}) },
      summary:
        `${items.length} change(s) since ${since}${tally ? `: ${tally}` : ''}.` +
        (truncated ? ` Showing the first ${MAX_ITEMS}; call again with since=${nextSince} for the rest.` : ''),
    }
  },
})
