// Events' capture target — the Tier 2 "mutate verb" resolver/applier for calendar
// events. Registered into the capture registry from registerEventRoutes so
// /api/capture/resolve + /api/capture/commit can turn a spoken noun phrase
// ("soccer", "the dentist appointment") into one upcoming event and apply
// reschedule/delete to it. Kept out of events.ts so it stays focused; imports the
// module's own service fns + the shared candidate ranker.
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
import { materializeMaster } from '../calendar/expansion.service'
import { rangeEvents, updateEvent, overrideOccurrence, softDeleteEvent, type EventRow } from './events'

// How far ahead the resolver looks for "the soccer game" — 60 days covers "next
// month's recital" while keeping the candidate list to what a person plausibly
// means from the capture bar (rangeEvents needs a bounded window anyway).
const LOOKAHEAD_DAYS = 60
const DAY_MS = 86_400_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

// ── Local↔UTC wall-clock math (mirrors capture.ts's zonedToUtc/tzOffsetMs; those
// are module-private, and importing the dispatcher from a target would invert the
// registry's dependency direction) ────────────────────────────────────────────
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(at)) m[p.type] = p.value
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +(m.hour === '24' ? '0' : m.hour), +m.minute, +m.second)
  return asUTC - at.getTime()
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number }

// The wall-clock (household-local) components of an instant.
function wallParts(at: Date, tz: string): Wall {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(at)) m[p.type] = p.value
  return { y: +m.year, mo: +m.month, d: +m.day, h: +(m.hour === '24' ? '0' : m.hour), mi: +m.minute }
}

// Wall-clock components in a tz → the UTC instant (offset re-checked at the guess,
// so DST transitions land on the right side).
function wallToUtc(w: Wall, tz: string): Date {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, 0)
  const off = tzOffsetMs(new Date(guess), tz)
  return new Date(guess - off)
}

// "Fri Jul 18 · 7:00 PM" (all-day events show just the day).
function whenLabel(at: Date, allDay: boolean, tz: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(at)
  if (allDay) return day
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at)
  return `${day} · ${time}`
}

function localYmd(at: Date, tz: string): string {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

// ── Commit-time row lookup ─────────────────────────────────────────────────────
// The authoritative shape of the chosen row, re-fetched at commit (never trusted
// from client meta): an occurrence row carries its series + slot handle, a single
// event stands alone. Visibility mirrors rangeEvents' rule — family events, or the
// caller's own personal ones.
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
        and (o.visibility = 'family' or o.owner_person_id = $3)`,
    [ctx.householdId, id, ctx.personId]
  )
  if (occ.rows[0]) return occ.rows[0]
  const single = await query<TargetRow>(
    `select e.title, e.starts_at, e.ends_at, e.all_day, null as series_id, null as occurrence_start
       from events e
      where e.household_id = $1 and e.id = $2 and e.deleted_at is null and e.rrule is null
        and (e.visibility = 'family' or e.owner_person_id = $3)`,
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

const eventCaptureTarget: CaptureTarget = {
  // Calendar is a core surface, never module-gated — this target is always on.
  isEnabled: () => true,
  disabledReason: 'Calendar is turned off.',
  supportedVerbs: ['reschedule', 'delete'],

  async resolveCandidates(ctx: ResolveCtx, req): Promise<Candidate[]> {
    // Upcoming only: you reschedule/cancel what hasn't happened yet. rangeEvents
    // returns the unified single+occurrence view (occurrence rows carry series_id +
    // occurrence_start — the 'this'-scope handle applyMutation needs).
    const from = localYmd(ctx.now, ctx.timezone)
    const to = localYmd(new Date(ctx.now.getTime() + LOOKAHEAD_DAYS * DAY_MS), ctx.timezone)
    const events = await rangeEvents(ctx.householdId, from, to, ctx.personId)

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

    if (cmd.verb === 'reschedule') {
      const newStart = rescheduledStart(row, cmd.args, ctx.timezone)
      // Preserve the duration — slide endsAt by the same delta the start moved.
      const patch: Record<string, unknown> = { startsAt: newStart.toISOString() }
      if (row.ends_at) {
        patch.endsAt = new Date(newStart.getTime() + (row.ends_at.getTime() - row.starts_at.getTime())).toISOString()
      }
      if (row.series_id && row.occurrence_start) {
        const ok = await overrideOccurrence(ctx.householdId, row.series_id, row.occurrence_start.toISOString(), patch)
        if (!ok) throw httpError(404, 'That event is gone.')
      } else {
        const ev = await updateEvent(ctx.householdId, cmd.targetId, patch)
        if (!ev) throw httpError(404, 'That event is gone.')
      }
      return { message: `Moved "${row.title}" to ${whenLabel(newStart, row.all_day, ctx.timezone)}` }
    }

    if (cmd.verb === 'delete') {
      if (row.series_id && row.occurrence_start) {
        const ok = await overrideOccurrence(ctx.householdId, row.series_id, row.occurrence_start.toISOString(), {}, { cancel: true })
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
