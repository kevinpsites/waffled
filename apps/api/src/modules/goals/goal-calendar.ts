// Calendar → goal auto-counting (Phase 1, single events). The bridge between a
// calendar event tagged with goal_id and the goal's progress log. An event is a
// *plan, not a fact*: nothing is written automatically. Once a linked, non-
// cancelled occurrence has ended we surface a "did this happen?" recap with an
// editable preview (goal · amount · who); only on confirm do we write a goal_log
// (source 'auto_calendar', ref_type 'event') and record an event_goal_logs row.
// That row is keyed on (event_id, occurrence_date, goal_id) so a sync re-run or a
// double-confirm never double-counts. See ROADMAP "auto-from-calendar bridge".
import createAPI, { type Request, type Response } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { requireTenant, type Tenant } from '../households/households'
import { logProgress } from './goals.service'
import { updateEvent } from '../events/events'
import { keywordMatch, type MatchGoal } from './goal-match'
import { loadMemory, loadMemoryGrouped, forgetMemory, clearMemory, memoryMatch, recordMatch, WEIGHT, AUTO_LINK_THRESHOLD } from './goal-match-memory'
import { getAiConfig, completeJson } from '../../platform/llm'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HOUR_UNITS = new Set(['hour', 'hours', 'hr', 'hrs', 'h'])
const MIN_UNITS = new Set(['min', 'mins', 'minute', 'minutes'])

// A cancelled occurrence shouldn't ask "did this happen?" — it didn't. Google's
// event status (confirmed | tentative | cancelled) lives in events.status; a
// cancelled Google event is also soft-deleted (deleted_at), so the deleted_at
// guard below already covers the sync path — this is the belt-and-suspenders for
// a locally-cancelled-but-not-deleted row.
const SKIP_STATUSES = `('cancelled')`

interface RecapRow {
  event_id: string
  title: string
  starts_at: Date
  ends_at: Date | null
  all_day: boolean
  occurrence_date: string
  goal_id: string
  goal_title: string
  goal_emoji: string | null
  goal_type: string
  unit: string | null
  tracking_mode: string
  goal_step_id: string | null
  step_label: string | null
  event_person_ids: string[]
  goal_person_ids: string[]
}

// Map an event's duration onto the goal's natural axis. Habit/Count = one
// completion (+1). Total in a time unit = the event's duration in that unit;
// a non-time Total (miles/pages — Phase 2) can't be inferred, so suggest 0 and
// let the person fill it in.
function suggestedAmount(row: RecapRow): number {
  if (row.goal_type === 'habit' || row.goal_type === 'count') return 1
  if (row.goal_type === 'total') {
    if (row.all_day || !row.ends_at) return 0
    const mins = Math.max(0, (row.ends_at.getTime() - row.starts_at.getTime()) / 60000)
    const unit = (row.unit ?? '').toLowerCase()
    if (HOUR_UNITS.has(unit)) return Math.round((mins / 60) * 100) / 100
    if (MIN_UNITS.has(unit)) return Math.round(mins)
    return 0
  }
  return 0
}

// Default attribution = event participants ∩ goal participants; if that's empty
// (e.g. the event has no one tagged), fall back to all the goal's participants.
function defaultPersonIds(row: RecapRow): string[] {
  const ev = new Set(row.event_person_ids ?? [])
  const both = (row.goal_person_ids ?? []).filter((id) => ev.has(id))
  return both.length ? both : (row.goal_person_ids ?? [])
}

// Pending recap items: linked single events whose occurrence has ended and that
// haven't been confirmed or skipped yet. Optionally scoped to one goal.
export async function recapQueue(householdId: string, goalId?: string | null) {
  const { rows } = await query<RecapRow>(
    `select e.id as event_id, e.title, e.starts_at, e.ends_at, e.all_day,
            (e.starts_at at time zone h.timezone)::date::text as occurrence_date,
            g.id as goal_id, g.title as goal_title, g.emoji as goal_emoji,
            g.goal_type, g.unit, g.tracking_mode,
            e.goal_step_id, gs.label as step_label,
            coalesce((select array_agg(ep.person_id::text)
                        from event_participants ep
                       where ep.event_id = e.id and ep.deleted_at is null), '{}') as event_person_ids,
            coalesce((select array_agg(gp.person_id::text)
                        from goal_participants gp
                       where gp.goal_id = g.id and gp.deleted_at is null), '{}') as goal_person_ids
       from events e
       join households h on h.id = e.household_id
       join goals g on g.id = e.goal_id and g.deleted_at is null and g.auto_from_calendar
       left join goal_steps gs on gs.id = e.goal_step_id and gs.deleted_at is null
       left join event_goal_logs egl
         on egl.event_id = e.id and egl.goal_id = e.goal_id
        and egl.occurrence_date = (e.starts_at at time zone h.timezone)::date
      where e.household_id = $1
        and e.deleted_at is null
        and e.goal_id is not null
        and e.rrule is null
        and coalesce(e.ends_at, e.starts_at) <= now()
        and (e.status is null or e.status not in ${SKIP_STATUSES})
        and egl.id is null
        -- A checklist recap needs a still-pending step to tick; amount-based goals
        -- (total/count/habit) surface regardless.
        and (g.goal_type <> 'checklist' or (gs.id is not null and gs.done_at is null))
        and ($2::uuid is null or g.id = $2)
      order by coalesce(e.ends_at, e.starts_at) desc
      limit 50`,
    [householdId, goalId ?? null]
  )
  return rows.map((r) => ({
    eventId: r.event_id,
    occurrenceDate: r.occurrence_date,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: r.all_day,
    goalId: r.goal_id,
    goalTitle: r.goal_title,
    goalEmoji: r.goal_emoji,
    goalType: r.goal_type,
    unit: r.unit,
    trackingMode: r.tracking_mode,
    suggestedAmount: suggestedAmount(r),
    defaultPersonIds: defaultPersonIds(r),
    goalParticipantIds: r.goal_person_ids ?? [],
    goalStepId: r.goal_step_id,
    stepLabel: r.step_label,
  }))
}

// Confirm a recap occurrence → write progress + the idempotency record. Returns
// 'logged' on a fresh write, 'duplicate' if it was already resolved (the unique
// key makes a re-confirm a no-op — never a double count), or null if the event/
// link no longer validates.
export async function confirmRecap(
  tenant: Tenant,
  eventId: string,
  occurrenceDate: string,
  amount: number,
  personIds: string[],
  note?: string | null
): Promise<'logged' | 'duplicate' | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // The event must still exist, belong to the household, and be linked to a goal
    // that accepts calendar contributions.
    const { rows } = await client.query<{ goal_id: string; goal_type: string; goal_step_id: string | null }>(
      `select e.goal_id, g.goal_type, e.goal_step_id from events e
         join goals g on g.id = e.goal_id and g.deleted_at is null and g.auto_from_calendar
        where e.id = $1 and e.household_id = $2 and e.deleted_at is null and e.goal_id is not null`,
      [eventId, tenant.householdId]
    )
    const link = rows[0]
    if (!link) {
      await client.query('rollback')
      return null
    }
    const goalId = link.goal_id
    // Claim the (event, occurrence, goal) slot first. ON CONFLICT DO NOTHING +
    // RETURNING means a second confirm gets no row back → we bail without logging.
    const claim = await client.query<{ id: string }>(
      `insert into event_goal_logs
         (household_id, event_id, occurrence_date, goal_id, goal_step_id, status, created_by)
       values ($1,$2,$3,$4,$5,'logged',$6)
       on conflict (event_id, occurrence_date, goal_id) do nothing
       returning id`,
      [tenant.householdId, eventId, occurrenceDate, goalId, link.goal_step_id, tenant.personId]
    )
    if (claim.rowCount === 0) {
      await client.query('rollback')
      return 'duplicate'
    }

    // Checklist goals don't take an amount — confirming ticks the linked step.
    // Done inside the claim transaction (it's a couple of small writes). We mirror
    // it to goal_logs like a manual tick (ref_type 'goal_step') so the activity
    // feed/streaks count it and an untick later cleans it up.
    if (link.goal_type === 'checklist') {
      const stepId = link.goal_step_id
      if (stepId) {
        const doneBy = personIds[0] ?? tenant.personId
        const upd = await client.query(
          `update goal_steps set done_at = now(), done_by = $1
            where id = $2 and goal_id = $3 and household_id = $4 and deleted_at is null and done_at is null
            returning id`,
          [doneBy, stepId, goalId, tenant.householdId]
        )
        if ((upd.rowCount ?? 0) > 0) {
          await client.query(
            `insert into goal_logs (household_id, goal_id, person_id, amount, note, source, ref_type, ref_id, created_by)
             values ($1,$2,$3,1,$4,'auto_calendar','goal_step',$5,$6)`,
            [tenant.householdId, goalId, doneBy, note ?? null, stepId, tenant.personId]
          )
        }
      }
      await client.query('commit')
      return 'logged'
    }

    await client.query('commit')
    // Write progress OUTSIDE the claim transaction (logProgress opens its own
    // connection). The claim row already guarantees idempotency.
    const logIds = await logProgress(tenant, goalId, amount, personIds, note ?? null, {
      source: 'auto_calendar',
      refType: 'event',
      refId: eventId,
    })
    if (logIds[0]) {
      await query(`update event_goal_logs set goal_log_id = $1 where id = $2`, [logIds[0], claim.rows[0].id])
    }
    return 'logged'
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Skip a recap occurrence — record it as resolved so the recap stops asking,
// without writing any progress. Idempotent on the same unique key.
export async function skipRecap(tenant: Tenant, eventId: string, occurrenceDate: string): Promise<boolean> {
  const { rows } = await query<{ goal_id: string }>(
    `select goal_id from events where id = $1 and household_id = $2 and deleted_at is null and goal_id is not null`,
    [eventId, tenant.householdId]
  )
  const goalId = rows[0]?.goal_id
  if (!goalId) return false
  await query(
    `insert into event_goal_logs (household_id, event_id, occurrence_date, goal_id, status, created_by)
     values ($1,$2,$3,$4,'skipped',$5)
     on conflict (event_id, occurrence_date, goal_id) do nothing`,
    [tenant.householdId, eventId, occurrenceDate, goalId, tenant.personId]
  )
  return true
}

// ── Smart suggestions (Phase B) ──────────────────────────────────────────────
// Untagged events that look like they could count toward a goal. Matching is
// layered cheapest-first: the household's learned memory, then the stateless
// keyword matcher, then (only for what's left, and only if an AI provider is on)
// one batched LLM call — whose answers are written back to memory so the family's
// matcher keeps getting faster. Suggestions cover amount goals (total/count/habit);
// checklist linking needs a step, which only the event editor offers.

interface SuggestEventRow {
  event_id: string
  title: string
  description: string | null
  starts_at: Date
  all_day: boolean
  person_ids: string[]
}
interface SuggestGoalRow {
  id: string
  title: string
  emoji: string | null
  goal_type: string
  person_ids: string[]
}

export interface Suggestion {
  eventId: string
  title: string
  startsAt: Date
  allDay: boolean
  goalId: string
  goalTitle: string
  goalEmoji: string | null
  via: 'memory' | 'keyword' | 'llm'
}

// Goals a given event's attendees are eligible for (participant superset rule;
// no attendees ⇒ any goal). Mirrors the manual picker + client matcher.
function eligibleGoals(eventPeople: string[], goals: SuggestGoalRow[]): SuggestGoalRow[] {
  if (!eventPeople.length) return goals
  return goals.filter((g) => {
    const gp = new Set(g.person_ids)
    return eventPeople.every((id) => gp.has(id))
  })
}

export async function suggestionQueue(householdId: string): Promise<Suggestion[]> {
  // Candidate events: untagged, not a planned meal, single (non-recurring), in a
  // window around now, not cancelled, not already dismissed.
  const { rows: events } = await query<SuggestEventRow>(
    `select e.id as event_id, e.title, e.description, e.starts_at, e.all_day,
            coalesce((select array_agg(ep.person_id::text)
                        from event_participants ep
                       where ep.event_id = e.id and ep.deleted_at is null), '{}') as person_ids
       from events e
      where e.household_id = $1
        and e.deleted_at is null
        and e.goal_id is null
        and e.rrule is null
        and (e.origin is null or e.origin <> 'meal_plan')
        and (e.status is null or e.status not in ${SKIP_STATUSES})
        and e.starts_at between now() - interval '7 days' and now() + interval '14 days'
        and not exists (select 1 from event_suggestion_dismissals d where d.event_id = e.id)
      order by e.starts_at desc
      limit 40`,
    [householdId]
  )
  if (events.length === 0) return []

  const { rows: goals } = await query<SuggestGoalRow>(
    `select g.id, g.title, g.emoji, g.goal_type,
            coalesce((select array_agg(gp.person_id::text)
                        from goal_participants gp
                       where gp.goal_id = g.id and gp.deleted_at is null), '{}') as person_ids
       from goals g
      where g.household_id = $1 and g.deleted_at is null and g.auto_from_calendar
        and g.goal_type in ('total','count','habit')`,
    [householdId]
  )
  if (goals.length === 0) return []
  const goalById = new Map(goals.map((g) => [g.id, g]))

  const mem = await loadMemory(householdId)
  const out: Suggestion[] = []
  const leftover: Array<{ ev: SuggestEventRow; candidates: SuggestGoalRow[] }> = []

  for (const ev of events) {
    const cands = eligibleGoals(ev.person_ids, goals)
    if (cands.length === 0) continue
    const candIds = new Set(cands.map((c) => c.id))
    // Match on the TITLE only — event descriptions are full of scheduling
    // boilerplate ("booking", "reschedule", Zoom links) that produces false hits.
    // 1) learned memory  2) keyword/concept
    const memId = memoryMatch(ev.title, candIds, mem)?.goalId ?? null
    const matchId = memId ?? keywordMatch(ev.title, null, cands as MatchGoal[])
    if (matchId && candIds.has(matchId)) {
      const g = goalById.get(matchId)!
      out.push({ eventId: ev.event_id, title: ev.title, startsAt: ev.starts_at, allDay: ev.all_day, goalId: g.id, goalTitle: g.title, goalEmoji: g.emoji, via: memId ? 'memory' : 'keyword' })
    } else {
      leftover.push({ ev, candidates: cands })
    }
  }

  // 3) LLM fallback for the unmatched — but only events we haven't already asked
  // about (each event is classified at most once; matches go to memory, so future
  // loads resolve them instantly without re-paying the LLM). One batched call.
  if (leftover.length) {
    const { provider } = await getAiConfig(householdId)
    if (provider !== 'heuristic') {
      const { rows: seenRows } = await query<{ event_id: string }>(
        `select event_id from event_llm_seen where household_id = $1`,
        [householdId]
      )
      const seen = new Set(seenRows.map((r) => r.event_id))
      const fresh = leftover.filter((l) => !seen.has(l.ev.event_id))
      if (fresh.length) {
        // Mark seen up front so a concurrent load doesn't re-ask in parallel.
        await query(
          `insert into event_llm_seen (event_id, household_id)
           select x.id, $1 from unnest($2::uuid[]) as x(id) on conflict do nothing`,
          [householdId, fresh.map((l) => l.ev.event_id)]
        )
        const llmMatches = await llmMatch(householdId, fresh)
        for (const { ev, candidates } of fresh) {
          const gid = llmMatches.get(ev.event_id)
          if (!gid) continue
          const g = candidates.find((c) => c.id === gid)
          if (!g) continue
          out.push({ eventId: ev.event_id, title: ev.title, startsAt: ev.starts_at, allDay: ev.all_day, goalId: g.id, goalTitle: g.title, goalEmoji: g.emoji, via: 'llm' })
          // Teach the household's matcher so we never pay for this phrasing again.
          await recordMatch(householdId, ev.title, g.id, WEIGHT.llm)
        }
      }
    }
  }
  return out
}

// One batched classification call: each event → one of its candidate goals, or
// null. Returns eventId → goalId. Best-effort (any failure ⇒ no LLM matches).
async function llmMatch(
  householdId: string,
  items: Array<{ ev: SuggestEventRow; candidates: SuggestGoalRow[] }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const payload = {
    events: items.slice(0, 25).map(({ ev, candidates }) => ({
      eventId: ev.event_id,
      title: ev.title,
      candidates: candidates.map((c) => ({ goalId: c.id, goalTitle: c.title })),
    })),
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { eventId: { type: 'string' }, goalId: { type: ['string', 'null'] } },
          required: ['eventId', 'goalId'],
        },
      },
    },
    required: ['matches'],
  }
  try {
    const { data } = await completeJson(householdId, {
      system:
        'You link a family calendar event to the goal it most likely contributes to. ' +
        'For each event, choose a goalId ONLY from that event\'s candidates, or null if none clearly fits. ' +
        'Be conservative: a wrong link is worse than no link. Reply via the tool schema.',
      user: JSON.stringify(payload),
      schema,
      schemaName: 'goal_matches',
      maxTokens: 1024,
    })
    const matches = (data as { matches?: Array<{ eventId?: string; goalId?: string | null }> })?.matches ?? []
    for (const m of matches) if (m.eventId && m.goalId) result.set(m.eventId, m.goalId)
  } catch {
    /* LLM unavailable / errored → fall through with no LLM matches */
  }
  return result
}

// One-off preview match for a not-yet-saved event (the modal's live suggestion).
// memory → keyword → LLM, read-only (no memory writes, no seen-marker — it's a
// preview; the real signal is recorded when the event is actually saved/linked).
export async function suggestOne(
  householdId: string,
  title: string,
  participantIds: string[]
): Promise<{ goalId: string; goalTitle: string; goalEmoji: string | null; via: 'memory' | 'keyword' | 'llm'; auto: boolean } | null> {
  if (!title.trim()) return null
  const { rows: goals } = await query<SuggestGoalRow>(
    `select g.id, g.title, g.emoji, g.goal_type,
            coalesce((select array_agg(gp.person_id::text) from goal_participants gp
                       where gp.goal_id = g.id and gp.deleted_at is null), '{}') as person_ids
       from goals g
      where g.household_id = $1 and g.deleted_at is null and g.auto_from_calendar
        and g.goal_type in ('total','count','habit')`,
    [householdId]
  )
  const eligible = eligibleGoals(participantIds, goals)
  if (eligible.length === 0) return null
  const eligIds = new Set(eligible.map((g) => g.id))
  const byId = new Map(eligible.map((g) => [g.id, g]))
  // auto=true → confident enough to pre-link in the modal (memory only — a learned,
  // repeatedly-confirmed pattern; never on a one-off keyword/LLM guess).
  const pack = (id: string, via: 'memory' | 'keyword' | 'llm', auto = false) => {
    const g = byId.get(id)!
    return { goalId: g.id, goalTitle: g.title, goalEmoji: g.emoji, via, auto }
  }

  const mem = await loadMemory(householdId)
  const memHit = memoryMatch(title, eligIds, mem)
  if (memHit) return pack(memHit.goalId, 'memory', memHit.score >= AUTO_LINK_THRESHOLD)
  const kwId = keywordMatch(title, null, eligible)
  if (kwId) return pack(kwId, 'keyword')

  const { provider } = await getAiConfig(householdId)
  if (provider !== 'heuristic') {
    const m = await llmMatch(householdId, [
      { ev: { event_id: 'preview', title } as SuggestEventRow, candidates: eligible },
    ])
    const gid = m.get('preview')
    if (gid && eligIds.has(gid)) return pack(gid, 'llm')
  }
  return null
}

// Link an untagged event to a goal from its suggestion. Validates the event is
// still untagged + the goal is auto-counting and eligible, then sets goal_id and
// teaches the household matcher (a human pick is the strongest signal).
export async function linkSuggestion(tenant: Tenant, eventId: string, goalId: string): Promise<'linked' | 'invalid'> {
  const { rows } = await query<{ title: string; person_ids: string[]; goal_people: string[]; auto: boolean; gtype: string }>(
    `select e.title,
            coalesce((select array_agg(ep.person_id::text) from event_participants ep
                       where ep.event_id = e.id and ep.deleted_at is null), '{}') as person_ids,
            coalesce((select array_agg(gp.person_id::text) from goal_participants gp
                       where gp.goal_id = g.id and gp.deleted_at is null), '{}') as goal_people,
            g.auto_from_calendar as auto, g.goal_type as gtype
       from events e
       join goals g on g.id = $3
      where e.id = $1 and e.household_id = $2 and e.deleted_at is null
        and e.goal_id is null and g.household_id = $2 and g.deleted_at is null`,
    [eventId, tenant.householdId, goalId]
  )
  const row = rows[0]
  if (!row || !row.auto) return 'invalid'
  const gp = new Set(row.goal_people)
  if (row.person_ids.length && !row.person_ids.every((id) => gp.has(id))) return 'invalid'
  // updateEvent records the human match signal (goalId in patch) — no double count.
  await updateEvent(tenant.householdId, eventId, { goalId })
  return 'linked'
}

export async function dismissSuggestion(tenant: Tenant, eventId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `select id from events where id = $1 and household_id = $2 and deleted_at is null`,
    [eventId, tenant.householdId]
  )
  if (!rows[0]) return false
  await query(
    `insert into event_suggestion_dismissals (household_id, event_id, created_by)
     values ($1,$2,$3) on conflict (event_id) do nothing`,
    [tenant.householdId, eventId, tenant.personId]
  )
  return true
}

export function registerGoalCalendarRoutes(api: Api): void {
  // The "did these happen?" queue (Today + goal detail). Optional ?goalId scopes
  // it to one goal.
  api.get('/api/goal-calendar/recap', async (req: Request) => {
    const tenant = await requireTenant(req)
    const goalId = typeof req.query?.goalId === 'string' && UUID_RE.test(req.query.goalId) ? req.query.goalId : null
    return { items: await recapQueue(tenant.householdId, goalId) }
  })

  api.post('/api/goal-calendar/recap/confirm', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as {
      eventId?: string
      occurrenceDate?: string
      amount?: unknown
      personIds?: string[]
      note?: string | null
    }
    if (!body.eventId || !UUID_RE.test(body.eventId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'eventId is required' })
    }
    if (!body.occurrenceDate || !DATE_RE.test(body.occurrenceDate)) {
      return res.status(400).json({ error: 'BadRequest', message: 'occurrenceDate (YYYY-MM-DD) is required' })
    }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'amount must be a non-zero number' })
    }
    const personIds = Array.isArray(body.personIds) ? body.personIds.filter((p) => typeof p === 'string') : []
    const result = await confirmRecap(tenant, body.eventId, body.occurrenceDate, amount, personIds, body.note ?? null)
    if (result === null) return res.status(404).json({ error: 'NotFound', message: 'event or goal link not found' })
    return res.status(201).json({ status: result })
  })

  api.post('/api/goal-calendar/recap/skip', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { eventId?: string; occurrenceDate?: string }
    if (!body.eventId || !UUID_RE.test(body.eventId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'eventId is required' })
    }
    if (!body.occurrenceDate || !DATE_RE.test(body.occurrenceDate)) {
      return res.status(400).json({ error: 'BadRequest', message: 'occurrenceDate (YYYY-MM-DD) is required' })
    }
    const ok = await skipRecap(tenant, body.eventId, body.occurrenceDate)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'event or goal link not found' })
    return res.status(200).json({ ok: true })
  })

  // Smart suggestions: untagged events that might count toward a goal.
  api.get('/api/goal-calendar/suggestions', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { items: await suggestionQueue(tenant.householdId) }
  })

  api.post('/api/goal-calendar/suggestions/link', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { eventId?: string; goalId?: string }
    if (!body.eventId || !UUID_RE.test(body.eventId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'eventId is required' })
    }
    if (!body.goalId || !UUID_RE.test(body.goalId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'goalId is required' })
    }
    const result = await linkSuggestion(tenant, body.eventId, body.goalId)
    if (result === 'invalid') return res.status(404).json({ error: 'NotFound', message: 'event or goal not linkable' })
    return res.status(200).json({ ok: true })
  })

  // Live single-event preview for the create/edit modal (memory → keyword → LLM).
  api.post('/api/goal-calendar/suggest-one', async (req: Request) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { title?: string; participantIds?: string[] }
    const title = typeof body.title === 'string' ? body.title : ''
    const personIds = Array.isArray(body.participantIds) ? body.participantIds.filter((p) => typeof p === 'string' && UUID_RE.test(p)) : []
    if (!title.trim()) return { suggestion: null }
    return { suggestion: await suggestOne(tenant.householdId, title, personIds) }
  })

  // Settings → Smart matching: view + forget the household's learned matches.
  api.get('/api/goal-calendar/memory', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { groups: await loadMemoryGrouped(tenant.householdId) }
  })

  api.post('/api/goal-calendar/memory/forget', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { goalId?: string; token?: string | null }
    if (!body.goalId || !UUID_RE.test(body.goalId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'goalId is required' })
    }
    await forgetMemory(tenant.householdId, body.goalId, body.token ?? null)
    return res.status(200).json({ ok: true })
  })

  api.delete('/api/goal-calendar/memory', async (req: Request) => {
    const tenant = await requireTenant(req)
    await clearMemory(tenant.householdId)
    return { ok: true }
  })

  api.post('/api/goal-calendar/suggestions/dismiss', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { eventId?: string }
    if (!body.eventId || !UUID_RE.test(body.eventId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'eventId is required' })
    }
    const ok = await dismissSuggestion(tenant, body.eventId)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    return res.status(200).json({ ok: true })
  })
}
