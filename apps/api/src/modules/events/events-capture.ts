// Events' capture target — the Tier 2 "mutate verb" resolver/applier for calendar
// events. Registered into the capture registry from registerEventRoutes so
// /api/capture/resolve + /api/capture/commit can turn a spoken noun phrase
// ("soccer", "the dentist appointment") into one upcoming event and apply
// reschedule/delete to it. Kept out of events.ts so it stays focused; imports the
// module's own service fns, the shared candidate ranker, and the shared tz helpers.
//
// SCOPE RULE: a quick-add mutate acts on THE OCCURRENCE, never the whole series —
// a recurring occurrence gets a scope='this' override (reschedule) or a cancel
// (delete), exactly like the PATCH/DELETE routes' 'this' scope; a single event goes
// through updateEvent / softDeleteEvent. The capture bar must never nuke a series.
import { query } from '../../platform/db'
import {
  registerCaptureTarget,
  httpError,
  type CaptureTarget,
  type ResolveCtx,
  type MutateCommand,
} from '../capture/capture-resolvers'
import { rankCandidates, type Candidate, type RankRow } from '../capture/candidate-match'
import { wallParts, wallToUtc, localYmd, whenLabel } from '../capture/tz'
import { materializeMaster } from '../calendar/expansion.service'
import { rangeEvents, updateEvent, overrideOccurrence, softDeleteEvent, visibleTo, type EventRow } from './events'

// How far ahead the resolver looks for "the soccer game" — 60 days covers "next
// month's recital" while keeping the candidate list to what a person plausibly
// means from the capture bar.
const LOOKAHEAD_DAYS = 60
// …and how far BACK, so a multi-day event that already started ("cancel the camping
// trip" mid-trip) is still resolvable. rangeEvents filters on starts_at::date, so an
// in-progress event is invisible unless the window opens before it began; the
// not-yet-ended filter below then drops anything genuinely over.
const LOOKBACK_DAYS = 30
const DAY_MS = 86_400_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

// ── Commit-time row lookup ─────────────────────────────────────────────────────
// The authoritative shape of the chosen row, re-fetched at commit (never trusted
// from client meta): an occurrence row carries its series + slot handle, a single
// event stands alone. Visibility reuses the module's own `visibleTo` (family events,
// or the caller's own personal ones) so resolve and commit enforce ONE rule.
interface TargetRow {
  title: string
  starts_at: Date
  ends_at: Date | null
  all_day: boolean
  series_id: string | null // set = a recurring occurrence
  occurrence_start: Date | null
}

async function findTargetRow(ctx: ResolveCtx, id: string): Promise<TargetRow | null> {
  const occ = await query<TargetRow>(
    `select coalesce(o.title, m.title) as title, o.starts_at, o.ends_at, o.all_day,
            m.id as series_id, o.original_start as occurrence_start
       from event_occurrences o
       join events m on m.id = o.event_id and m.deleted_at is null
      where o.household_id = $1 and o.id = $2 and o.deleted_at is null
        ${visibleTo('o', '$3')}`,
    [ctx.householdId, id, ctx.personId]
  )
  if (occ.rows[0]) return occ.rows[0]
  const single = await query<TargetRow>(
    `select e.title, e.starts_at, e.ends_at, e.all_day, null as series_id, null as occurrence_start
       from events e
      where e.household_id = $1 and e.id = $2 and e.deleted_at is null and e.rrule is null
        ${visibleTo('e', '$3')}`,
    [ctx.householdId, id, ctx.personId]
  )
  return single.rows[0] ?? null
}

// The new starts_at for a reschedule: keep whatever half (date/time) wasn't spoken.
function rescheduledStart(row: TargetRow, args: Record<string, unknown>, tz: string): Date {
  const date = typeof args.date === 'string' ? args.date.trim() : ''
  const time = typeof args.time === 'string' ? args.time.trim() : ''
  if (!date && !time) {
    throw httpError(400, "Tell me when to move it to — e.g. 'move soccer to Thursday 4pm'.")
  }
  if (date && (!DATE_RE.test(date) || Number.isNaN(Date.parse(date)))) {
    throw httpError(400, "That date didn't make sense — try something like 'Thursday' or 'July 20'.")
  }
  const tm = time ? TIME_RE.exec(time) : null
  if (time && !tm) {
    throw httpError(400, "That time didn't make sense — try something like '4pm' or '16:00'.")
  }
  const w = wallParts(row.starts_at, tz)
  if (date) {
    const [y, mo, d] = date.split('-').map(Number)
    w.y = y; w.mo = mo; w.d = d
  }
  if (tm) {
    w.h = +tm[1]; w.mi = +tm[2]
  }
  return wallToUtc(w, tz)
}

// Is this event still worth offering to reschedule/cancel — i.e. not yet over? Timed
// events compare their end (or start, if open-ended) to now; all-day events count as
// "current" through the end of their day (so today's all-day fair still resolves in
// the afternoon). This is what actually enforces "upcoming only" — the resolve window
// is deliberately wide (see LOOKBACK_DAYS) so ongoing multi-day events aren't missed.
function notYetOver(e: EventRow, now: Date, tz: string): boolean {
  if (e.all_day) {
    const today = localYmd(now, tz)
    const lastDay = localYmd(e.ends_at ?? e.starts_at, tz)
    return lastDay >= today
  }
  const end = e.ends_at ?? e.starts_at
  return end.getTime() >= now.getTime()
}

const eventCaptureTarget: CaptureTarget = {
  // Calendar is a core surface, never module-gated — this target is always on.
  isEnabled: () => true,
  disabledReason: 'Calendar is turned off.',
  supportedVerbs: ['reschedule', 'delete'],

  async resolveCandidates(ctx: ResolveCtx, req): Promise<Candidate[]> {
    // You reschedule/cancel what isn't over yet. rangeEvents returns the unified
    // single+occurrence view (occurrence rows carry series_id + occurrence_start — the
    // 'this'-scope handle applyMutation needs). The window opens LOOKBACK_DAYS back so
    // an in-progress multi-day event isn't filtered out by starts_at::date; notYetOver
    // then drops anything that has already ended (incl. this morning's appointment,
    // which would otherwise auto-select as the sole match).
    const from = localYmd(new Date(ctx.now.getTime() - LOOKBACK_DAYS * DAY_MS), ctx.timezone)
    const to = localYmd(new Date(ctx.now.getTime() + LOOKAHEAD_DAYS * DAY_MS), ctx.timezone)
    const events = (await rangeEvents(ctx.householdId, from, to, ctx.personId)).filter((e) =>
      notYetOver(e, ctx.now, ctx.timezone)
    )

    const byId = new Map<string, EventRow>(events.map((e) => [e.id, e]))
    const rows: RankRow[] = events.map((e) => ({ id: e.id, title: e.title }))
    return rankCandidates(req.target.description, rows).map((c) => {
      const ev = byId.get(c.id)!
      return {
        ...c,
        subtitle: whenLabel(ev.starts_at, ev.all_day, ctx.timezone),
        // Echoed back on commit for the client's benefit; applyMutation re-derives
        // the series/occurrence handle from the DB rather than trusting this.
        meta: { seriesId: ev.series_id ?? ev.id, occurrenceStart: ev.occurrence_start?.toISOString() ?? null },
      }
    })
  },

  async applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<{ message: string }> {
    const row = await findTargetRow(ctx, cmd.targetId)
    if (!row) throw httpError(404, 'That event is gone.')
    const isOccurrence = row.series_id != null && row.occurrence_start != null

    if (cmd.verb === 'reschedule') {
      const newStart = rescheduledStart(row, cmd.args, ctx.timezone)
      const hasTime = typeof cmd.args.time === 'string' && cmd.args.time.trim() !== ''
      // Giving an all-day event a clock time turns it into a timed event. A single
      // event can carry that (clear all_day); a recurring occurrence can't — its
      // override row has no all_day column — so say so rather than silently writing a
      // time that no calendar surface renders.
      const convertToTimed = row.all_day && hasTime
      let allDay = row.all_day
      const patch: Record<string, unknown> = { startsAt: newStart.toISOString() }
      if (convertToTimed) {
        if (isOccurrence) {
          throw httpError(400, "That's an all-day event — I can move it to another day, but not to a specific time.")
        }
        patch.allDay = false
        patch.endsAt = null // an all-day span carries no meaningful duration once it's timed
        allDay = false
      } else if (row.ends_at) {
        // Preserve the duration — slide endsAt by the same delta the start moved.
        patch.endsAt = new Date(newStart.getTime() + (row.ends_at.getTime() - row.starts_at.getTime())).toISOString()
      }

      if (isOccurrence) {
        const ok = await overrideOccurrence(ctx.householdId, row.series_id!, row.occurrence_start!.toISOString(), patch)
        if (!ok) throw httpError(404, 'That event is gone.')
      } else {
        const ev = await updateEvent(ctx.householdId, cmd.targetId, patch)
        if (!ev) throw httpError(404, 'That event is gone.')
      }
      return { message: `Moved "${row.title}" to ${whenLabel(newStart, allDay, ctx.timezone)}` }
    }

    if (cmd.verb === 'delete') {
      if (isOccurrence) {
        const ok = await overrideOccurrence(ctx.householdId, row.series_id!, row.occurrence_start!.toISOString(), {}, { cancel: true })
        if (!ok) throw httpError(404, 'That event is gone.')
        return { message: `Canceled "${row.title}" (just this one)` }
      }
      const ok = await softDeleteEvent(ctx.householdId, cmd.targetId)
      if (!ok) throw httpError(404, 'That event is gone.')
      // Tombstone any occurrences (no-op for a single event) — same as the route.
      await materializeMaster(cmd.targetId)
      return { message: `Canceled "${row.title}"` }
    }

    // supportedVerbs gates everything else at the dispatcher already.
    throw httpError(400, "Can't do that to a calendar event")
  },
}

// Called from registerEventRoutes(api) at startup wiring so the target is in the
// registry before any /api/capture/{resolve,commit} request arrives.
export function registerEventCaptureTarget(): void {
  registerCaptureTarget('event', eventCaptureTarget)
}
