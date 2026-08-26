// Rhythms domain — the standing intentions that should keep happening, and the one
// place to confirm they actually will. See docs/product/rhythms-plan.md.
//
// Two shapes, and the difference is what closes out a period:
//   'completion' — you did the thing. Surfaces as `kind: 'due'`.
//   'scheduling' — a calendar event exists for the period. Surfaces as
//                  `kind: 'unscheduled'`. We never ask whether it happened; getting
//                  the opportunity onto the calendar IS the outcome.
//
// That second sentence is the whole line between a rhythm and a goal, and it is a
// copy rule as much as a data one: nothing here says "streak", "completed" or
// "on track" for a scheduling rhythm. The question is "did this get scheduled?".
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete, localToday } from './client'
import { useRefetchOn, emit } from './bus'

export type SatisfiedBy = 'completion' | 'scheduling'

export interface Rhythm {
  id: string
  title: string
  emoji: string | null
  notes: string | null
  personId: string | null
  satisfiedBy: SatisfiedBy
  /** Postgres interval text — '7 days', '3 mons'. Render via cadenceLabel. */
  every: string
  /** scheduling only: the anchor the period grid is measured from (YYYY-MM-DD). */
  startsOn: string | null
  autoSchedule: boolean
  rrule: string | null
  /** Postgres interval text, clamped server-side to at most half of `every`. */
  leadTime: string
  lastCompletedAt: string | null
  nextDueAt: string | null
  isActive: boolean
}

// A rhythm plus where it stands right now, as `GET /api/rhythms` returns it. The
// period bounds are null for the completion shape, which has no grid by design —
// its clock restarts from whenever you actually did it — and for that shape
// `satisfied` just means "not yet due".
export interface RhythmWithPeriod extends Rhythm {
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  satisfied: boolean
  /**
   * When the event that settles this period starts, or null.
   *
   * Null is NOT "unsettled": a **skip** settles a period and has no time, and the
   * completion shape has no periods at all. On a scheduling rhythm,
   * `satisfied && bookedAt === null` is exactly "skipped".
   */
  bookedAt: string | null
  bookedAllDay: boolean | null
  /**
   * Whether a live recurring event still exists for this rhythm.
   *
   * Only meaningful on an auto-scheduled one, where it separates two situations an empty
   * period cannot tell apart on its own: the series is **gone** (deleted, or the
   * recurrence ran out) and wants putting back, versus the series is **alive** and this
   * one period has nothing in it. Different sentences, different buttons.
   */
  hasSeries: boolean
}

// One period of one rhythm — enough to book or skip it. An unscheduled attention
// item is one of these; so is a row from the list once its period bounds are known,
// which is what lets a rhythm be booked before its runway has even opened.
export interface RhythmPeriod {
  rhythm: Rhythm
  periodStart: string
  periodEnd: string
  /** See RhythmWithPeriod.hasSeries. Decides whether booking restores the recurrence. */
  hasSeries: boolean
}

export type AttentionItem =
  | { kind: 'due'; rhythm: Rhythm; dueAt: string; overdue: boolean }
  | {
      kind: 'unscheduled'
      rhythm: Rhythm
      periodStart: string
      periodEnd: string
      /** See RhythmWithPeriod.hasSeries. */
      hasSeries: boolean
    }

export interface Completion {
  id: string
  personId: string | null
  completedAt: string
  notes: string | null
}

/**
 * A page of history plus a statistic taken over all of it.
 *
 * `averageIntervalDays` is deliberately NOT derivable from `completions`: the list is
 * capped and the average is not, so computing one from the other would give a *recent*
 * average wearing the wrong label. Null from fewer than two completions — one date is not
 * an interval.
 */
export interface CompletionHistory {
  completions: Completion[]
  total: number
  averageIntervalDays: number | null
}

export interface CreateRhythmInput {
  title: string
  emoji?: string | null
  notes?: string | null
  personId?: string | null
  satisfiedBy: SatisfiedBy
  /** An interval Postgres understands — '3 months', '7 days'. */
  every: string
  leadTime?: string
  // completion shape
  nextDueAt?: string
  // scheduling shape
  startsOn?: string
  autoSchedule?: boolean
  rrule?: string | null
}

// Only the fields that are safe to change in place. `satisfiedBy`, `startsOn`,
// `autoSchedule` and `rrule` are absent on purpose, and the server refuses them:
// re-anchoring a live rhythm would silently re-interpret the periods it has already
// skipped (they're keyed on period_start) and point its bookings at periods that no
// longer exist. Changing the shape or the anchor means retiring it and making a new one.
export interface UpdateRhythmInput {
  title?: string
  emoji?: string | null
  notes?: string | null
  personId?: string | null
  every?: string
  leadTime?: string
  isActive?: boolean
  /**
   * completion shape only — the server refuses it on a scheduling rhythm, whose periods
   * ARE its anchor and whose skips are keyed on them. See `pushOut`.
   */
  nextDueAt?: string
}

export interface ScheduleRhythmInput {
  startsAt: string
  endsAt?: string | null
  allDay?: boolean
}

export const rhythmsApi = {
  list: () => apiGet<{ rhythms: RhythmWithPeriod[] }>('/api/rhythms'),
  // Takes the horizon and nothing else — there is no window. `to` is load-bearing
  // twice over: it is how far ahead we look AND the date that picks which period a
  // scheduling rhythm reports on, so asking further out silently answers about a
  // LATER period. Every caller here passes today.
  attention: (to: string) => apiGet<{ items: AttentionItem[] }>(`/api/rhythms/attention?to=${to}`),
  create: (input: CreateRhythmInput) =>
    apiSend<{ rhythm: Rhythm }>('POST', '/api/rhythms', input).then((r) => { emit('rhythms'); return r }),
  // Edit in place. See UpdateRhythmInput for what is deliberately not here.
  update: (id: string, patch: UpdateRhythmInput) =>
    apiSend<{ rhythm: Rhythm }>('PATCH', `/api/rhythms/${id}`, patch).then((r) => { emit('rhythms'); return r }),
  // Retire one for good. Soft server-side, so the completion history survives;
  // pausing (isActive) stays the reversible option.
  remove: (id: string) => apiDelete(`/api/rhythms/${id}`).then((r) => { emit('rhythms'); return r }),
  complete: (id: string, body: { completedAt?: string; notes?: string } = {}) =>
    apiSend<{ rhythm: Rhythm }>('POST', `/api/rhythms/${id}/complete`, body).then((r) => { emit('rhythms'); return r }),
  // Books a period into a REAL calendar event. Title and assignee come from the
  // rhythm itself, so a booking UI needs a time picker and nothing else — retyping
  // the title is precisely the friction that keeps these things off the calendar.
  schedule: (id: string, input: ScheduleRhythmInput) =>
    apiSend<{ event: { id: string } }>('POST', `/api/rhythms/${id}/schedule`, input).then((r) => {
      emit('rhythms')
      return r
    }),
  // How a period goes quiet without inventing a calendar entry for something that
  // genuinely isn't happening this time round.
  skip: (id: string, periodStart: string) =>
    apiSend<{ ok: true }>('POST', `/api/rhythms/${id}/skip`, { periodStart }).then((r) => { emit('rhythms'); return r }),
  completions: (id: string, limit?: number) =>
    apiGet<CompletionHistory>(
      `/api/rhythms/${id}/completions${limit === undefined ? '' : `?limit=${limit}`}`
    ),
}

// ── Rendering Postgres intervals ────────────────────────────────────────────────
// `interval::text` comes back in Postgres shorthand ('3 mons', '3 days 12:00:00'),
// which is not something to put in front of a person.

interface Parts { year: number; mon: number; week: number; day: number; hour: number; min: number }

function parseInterval(text: string): Parts {
  const p: Parts = { year: 0, mon: 0, week: 0, day: 0, hour: 0, min: 0 }
  if (!text) return p
  const re = /(-?\d+)\s*(years?|yrs?|mons?|months?|weeks?|days?|hours?|hrs?|mins?|minutes?|secs?|seconds?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1])
    const u = m[2]
    if (u.startsWith('year') || u.startsWith('yr')) p.year += n
    else if (u.startsWith('mon')) p.mon += n
    else if (u.startsWith('week')) p.week += n
    else if (u.startsWith('day')) p.day += n
    else if (u.startsWith('hour') || u.startsWith('hr')) p.hour += n
    else if (u.startsWith('min')) p.min += n
  }
  // The HH:MM:SS tail Postgres appends for sub-day remainders ('3 days 12:00:00').
  const clock = /(-?\d+):(\d{2}):(\d{2})/.exec(text)
  if (clock) {
    p.hour += Number(clock[1])
    p.min += Number(clock[2])
  }
  return p
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`
}

/** '3 mons' → '3 months'; '7 days' → '1 week'; '3 days 12:00:00' → '3 days 12 hours'. */
export function formatInterval(text: string): string {
  const p = parseInterval(text ?? '')
  const out: string[] = []
  if (p.year) out.push(plural(p.year, 'year'))
  if (p.mon) out.push(plural(p.mon, 'month'))
  // Whole weeks read better than "14 days"; a remainder stays in days.
  let weeks = p.week
  let days = p.day
  if (days && days % 7 === 0) {
    weeks += days / 7
    days = 0
  }
  if (weeks) out.push(plural(weeks, 'week'))
  if (days) out.push(plural(days, 'day'))
  if (p.hour) out.push(plural(p.hour, 'hour'))
  if (p.min) out.push(plural(p.min, 'minute'))
  return out.join(' ')
}

export type CadenceUnit = 'days' | 'weeks' | 'months' | 'years'

/**
 * The inverse of what the create form builds: put a stored cadence back into a
 * number + unit picker so it survives an edit. Whole weeks collapse, matching how
 * formatInterval reads them out.
 */
export function splitCadence(every: string): { count: number; unit: CadenceUnit } {
  const p = parseInterval(every ?? '')
  if (p.year) return { count: p.year, unit: 'years' }
  if (p.mon) return { count: p.mon, unit: 'months' }
  const days = p.day + p.week * 7
  if (days) return days % 7 === 0 ? { count: days / 7, unit: 'weeks' } : { count: days, unit: 'days' }
  // Nothing legible — a week is a far safer default than a zero-length cadence,
  // which Postgres would reject and which could never close a period.
  return { count: 1, unit: 'weeks' }
}

/**
 * A runway in whole days, for the form's number input — and for the cap below.
 *
 * Truncates, deliberately. Serving both callers is what forces it: the cap is
 * `floor(intervalDays(every) / 2)`, so rounding a half-day up could put the field above a
 * ceiling derived from this very helper. A weekly rhythm stored at the clamped `3 days
 * 12:00:00` then opened showing "4" above a sentence reading "the last 3 days … (4 days
 * won't fit in a week)" — the form warning that it had trimmed a number nobody typed.
 */
export function intervalDays(leadTime: string): number {
  const p = parseInterval(leadTime ?? '')
  const days = p.year * 365 + p.mon * 30 + p.week * 7 + p.day + p.hour / 24 + p.min / 1440
  return Math.trunc(days)
}

/**
 * What the nudge runway will ACTUALLY be, once the server has had it.
 *
 * The runway is stored as `least(leadTime, every / 2)`: a warning window longer than the
 * cycle never closes, so the item would nag forever and be learned as noise. The form,
 * though, showed the number that was typed — so a weekly rhythm asked for 14 days' notice,
 * was quietly given 3, and the person who set it had no way to know why nothing appeared
 * when they expected it.
 */
export function nudgePlan(every: string, leadDays: number): { effectiveDays: number; capped: boolean } {
  const asked = Math.max(0, Math.round(leadDays || 0))
  const half = Math.floor(intervalDays(every) / 2)
  // An unreadable cadence gives no cap to apply — better to echo the request than to
  // invent a clamp from a number we couldn't parse.
  if (half <= 0) return { effectiveDays: asked, capped: false }
  return { effectiveDays: Math.min(asked, half), capped: asked > half }
}

/**
 * The runway in a sentence, naming the window it counts back from.
 *
 * "Start nudging me this many days before the period ends" assumed you knew what "the
 * period" was — reasonably answered with "what period? I'm scheduling it every week". For
 * a scheduling rhythm the period IS one cadence: each one is a fresh window to get the
 * thing booked, and the runway is its tail.
 */
export function nudgeExplainer(every: string, leadDays: number): string {
  const { effectiveDays, capped } = nudgePlan(every, leadDays)
  const window = cadenceLabel(every) || 'every period'
  const tail = effectiveDays <= 0
    ? 'on its last day'
    : `for the last ${plural(effectiveDays, 'day')} of it`
  const clamp = capped
    ? ` (${plural(Math.max(0, Math.round(leadDays || 0)), 'day')} won't fit in ${window.replace(/^every /, 'a ')}, so it's trimmed to half the cycle — a runway longer than the cycle never goes quiet)`
    : ''
  return `A fresh window to book it opens ${window}. You'll be nudged ${tail}, and only while nothing's on the calendar for it${clamp}.`
}

/** '7 days' → 'every week'; '3 mons' → 'every 3 months'. */
export function cadenceLabel(every: string): string {
  const text = formatInterval(every)
  if (!text) return ''
  // A single "1 <unit>" reads as "every week", not "every 1 week".
  const one = /^1 (year|month|week|day|hour|minute)$/.exec(text)
  return one ? `every ${one[1]}` : `every ${text}`
}

// Whole calendar days between two moments, counted on the VIEWER's clock. Doing
// this in UTC reads correct all afternoon and then slips a day every evening west
// of UTC (and every small hour east of it) — which is when a kitchen kiosk is
// actually being looked at. Matches localToday().
function dayDiff(target: Date, now: Date): number {
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / 86400000)
}

/**
 * The completion shape's status line. Overdue is stated plainly — this is a
 * maintenance register, not a scorecard, so there is no "missed" or "broken".
 */
export function dueLabel(dueAt: string, overdue: boolean, now: Date = new Date()): string {
  const days = dayDiff(new Date(dueAt), now)
  if (overdue || days < 0) {
    const late = Math.max(1, -days)
    // "late", matching the register's countdown, rather than "overdue" — the two
    // surfaces describe the same rhythm and should not use two words for it.
    return `${plural(late, 'day')} late`
  }
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `in ${plural(days, 'day')}`
}

/**
 * The scheduling shape's status line. Deliberately about the booking window
 * closing — never about following through, which is the question a rhythm
 * does not ask.
 */
export function periodLabel(periodEnd: string, now: Date = new Date()): string {
  // periodEnd is a calendar DATE, not an instant, so it is read as local midnight.
  const days = dayDiff(new Date(`${periodEnd}T00:00:00`), now)
  if (days < 0) return 'this period has ended'
  if (days === 0) return 'this period ends today'
  return `${plural(days, 'day')} left to book it`
}

// ── The register, grouped by when rather than by kind ───────────────────────────
//
// The screen used to be two sections named after the two shapes — "It gets scheduled"
// and "You do it" — which sorts a household's rhythms by a distinction only the schema
// cares about. Asked "what do I owe this week", you had to read both and do the merge
// yourself. Grouping by urgency answers it in one pass, and the shape stops being a
// heading: it survives in the words of the row ("last done May 12" versus "not on the
// calendar yet") and in the verb on its button ("I did it" versus "Book a time"), which
// is where the difference actually bears on what you do next.

/**
 * How far ahead "Coming up" looks, in days.
 *
 * A flat fortnight, deliberately, rather than something derived from each rhythm's own
 * runway. The runway governs *nudging* — when a rhythm has earned the right to
 * interrupt you — and that is exactly what "Needs you now" already reads. This band
 * answers a different question, asked by someone who has deliberately opened the page:
 * what is on the horizon. Deriving it per-rhythm would file a quarterly rhythm's
 * 45-day warning and a weekly one's 3-day warning under one heading and call both
 * "coming up", which is not a horizon anyone could read.
 */
const COMING_UP_DAYS = 14

export type Urgency = 'now' | 'soon' | 'steady' | 'paused'

/** A calendar date (YYYY-MM-DD) reads as local midnight; an instant stands as it is. */
function asMoment(value: string): Date {
  return new Date(value.length === 10 ? `${value}T00:00:00` : value)
}

/**
 * Whole days until whatever this rhythm is counting toward — its due date if you do it,
 * the closing of the booking window if it gets scheduled. null when there is nothing to
 * count toward, which the callers render as no countdown rather than as a zero.
 */
export function daysToGo(r: RhythmWithPeriod, now: Date = new Date()): number | null {
  const target = r.satisfiedBy === 'scheduling' ? r.currentPeriodEnd : r.nextDueAt
  if (!target) return null
  const d = asMoment(target)
  return Number.isNaN(d.getTime()) ? null : dayDiff(d, now)
}

/**
 * Which of the register's four bands a rhythm belongs in.
 *
 * "Needs you now" is the server's own attention list and nothing else. The Today card
 * reads that same endpoint, so a second threshold invented here would let one rhythm be
 * urgent on one half of a screen and calm on the other — which reads as a bug because
 * it is one.
 */
export function urgencyOf(
  r: RhythmWithPeriod,
  attention: AttentionItem | undefined,
  now: Date = new Date(),
): Urgency {
  // Off means off. Ordering a paused rhythm by how overdue it is would be sorting it
  // by a consequence we have deliberately suspended.
  if (!r.isActive) return 'paused'
  if (attention) return 'now'
  // A booked period is finished business — booking it WAS the thing to do, and whether
  // it then happened is the question this shape refuses to ask.
  if (r.satisfiedBy === 'scheduling' && r.satisfied) return 'steady'
  const days = daysToGo(r, now)
  if (days === null) return 'steady'
  // Past due and yet absent from /attention means that call is in flight or has failed.
  // The row must not go quiet in the meantime; being late is the one state that cannot
  // afford to wait on a second request.
  if (days < 0) return 'now'
  return days <= COMING_UP_DAYS ? 'soon' : 'steady'
}

/** The number and unit that anchor a row, plus how loudly to say it. */
export interface RhythmCountdown {
  num: string
  unit: string
  tone: 'late' | 'near' | 'soft' | 'done'
}

/**
 * The countdown that anchors every row — the same number the Today card shows.
 *
 * Tone comes from the group rather than from the arithmetic, so a row can never argue
 * with the heading it is sitting under. Units coarsen with distance because a register
 * is read at a glance: "7 months" is a fact you can act on, "213 days" is one you have
 * to convert first.
 */
export function countdown(
  r: RhythmWithPeriod,
  urgency: Urgency,
  now: Date = new Date(),
): RhythmCountdown | null {
  if (r.satisfiedBy === 'scheduling' && r.satisfied) {
    return { num: 'Booked', unit: 'this period', tone: 'done' }
  }
  const days = daysToGo(r, now)
  if (days === null) return null
  const tone: RhythmCountdown['tone'] = urgency === 'now' ? 'late' : urgency === 'soon' ? 'near' : 'soft'

  if (r.satisfiedBy === 'scheduling') {
    // Always about the window, never about follow-through.
    if (days <= 0) return { num: 'Today', unit: 'last day', tone }
    return { num: String(days), unit: days === 1 ? 'day left' : 'days left', tone }
  }
  if (days < 0) {
    const late = -days
    return { num: String(late), unit: late === 1 ? 'day late' : 'days late', tone }
  }
  if (days === 0) return { num: 'Today', unit: 'due', tone }
  if (days <= 13) return { num: String(days), unit: days === 1 ? 'day' : 'days', tone }
  if (days < 60) {
    const weeks = Math.round(days / 7)
    return { num: String(weeks), unit: weeks === 1 ? 'week' : 'weeks', tone }
  }
  const months = Math.round(days / 30)
  return { num: String(months), unit: months === 1 ? 'month' : 'months', tone }
}

/**
 * How much of the current cycle is spent, 0–100, for the hairline track under a row.
 *
 * The two shapes measure from different places, which is the data model showing through
 * honestly: a scheduling rhythm has a real period grid, while a completion rhythm has
 * none by design — its clock restarts from when you actually did it, which is the whole
 * reason lateness moves the next one instead of stacking misses.
 *
 * Returns null rather than a number it cannot stand behind. Overdue would otherwise
 * compute past 100 (a 340%-wide bar that `overflow: hidden` quietly disguises), and a
 * completion backdated past its own due date inverts the window into a negative one.
 */
export function periodProgress(r: RhythmWithPeriod, now: Date = new Date()): number | null {
  let start: Date
  let end: Date
  if (r.satisfiedBy === 'scheduling') {
    if (!r.currentPeriodStart || !r.currentPeriodEnd) return null
    start = asMoment(r.currentPeriodStart)
    end = asMoment(r.currentPeriodEnd)
  } else {
    if (!r.nextDueAt) return null
    end = asMoment(r.nextDueAt)
    // Never completed: the cycle it is in started one cadence back. The 30-day month
    // that intervalDays assumes is wrong by a day or two, which is invisible at 3px.
    start = r.lastCompletedAt
      ? asMoment(r.lastCompletedAt)
      : new Date(end.getTime() - intervalDays(r.every) * 86400000)
  }
  const total = end.getTime() - start.getTime()
  if (!Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round(((now.getTime() - start.getTime()) / total) * 100)))
}

/**
 * Move a date on by one cadence, on the calendar rather than in milliseconds.
 *
 * Months are the reason this exists: "every 3 months" from Aug 19 means Nov 19, and
 * adding `3 * 30` days says Nov 17. The clamp on the second line is the other half —
 * `setMonth` on Jan 31 rolls into March, silently skipping February altogether, so a
 * month-end date is pulled back to the last day that month actually has.
 */
export function addCadence(from: Date, every: string): Date {
  const { count, unit } = splitCadence(every)
  const d = new Date(from.getTime())
  if (unit === 'days') d.setDate(d.getDate() + count)
  else if (unit === 'weeks') d.setDate(d.getDate() + count * 7)
  else {
    const months = unit === 'years' ? count * 12 : count
    const day = d.getDate()
    d.setDate(1)
    d.setMonth(d.getMonth() + months)
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
  }
  return d
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

export interface ConsequenceInput {
  satisfiedBy: SatisfiedBy
  /** The cadence as the form holds it — '3 months'. */
  every: string
  /** The runway as TYPED. The clamp is applied here, not by the caller. */
  leadDays: number
  /**
   * completion — the date the first one is due (YYYY-MM-DD).
   * scheduling  — the day the first period opens (YYYY-MM-DD).
   */
  anchor: string
}

export interface Consequence {
  /** completion: when it comes due. scheduling: when the booking window closes. */
  landsOn: Date
  /** The day it starts asking: onto Today, or into "Needs you now". */
  nudgeFrom: Date
  /** The typed runway did not fit in half the cadence, so the server will trim it. */
  capped: boolean
}

/**
 * What the sentence will actually DO, in two dates.
 *
 * The runway goes through `nudgePlan` rather than being subtracted raw. The server
 * stores `least(lead_time, every / 2)`, so a weekly rhythm asked for 14 days' notice
 * keeps 3 — and a card promising "on your Today card from the 5th" off the typed 14
 * would be naming a day the server is never going to nudge on. The register learned
 * this once already; the promise has to be made against the stored number.
 */
/** How far "push it out" moves a due date. A week — long enough to be worth pressing. */
export const PUSH_DAYS = 7

/**
 * The new due date for "push it out a week", or null when there is nothing to push.
 *
 * Counted from **today or the due date, whichever is later**. Both halves matter:
 *
 *  - From today when it's late. An oil change six days overdue, pushed "a week" from its
 *    own due date, would come back tomorrow — a control that reads as a week and delivers
 *    a day is worse than no control.
 *  - From the due date when it hasn't arrived. Something due in three days should move to
 *    ten days out, not reset to seven; the rhythm keeps the shape of its own schedule
 *    rather than being re-anchored to whenever you happened to press the button.
 *
 * It is one period's reprieve either way: marking it done re-anchors the clock from when
 * you actually did it, so the push is forgotten rather than compounding.
 */
export function pushOut(nextDueAt: string | null, now: Date = new Date()): string | null {
  if (!nextDueAt) return null
  const due = new Date(nextDueAt)
  if (Number.isNaN(due.getTime())) return null
  const from = due.getTime() > now.getTime() ? due : now
  const moved = new Date(from.getTime())
  moved.setDate(moved.getDate() + PUSH_DAYS)
  return moved.toISOString()
}

export function consequence(input: ConsequenceInput): Consequence | null {
  const anchor = input.anchor ? asMoment(input.anchor) : null
  if (!anchor || Number.isNaN(anchor.getTime())) return null

  // A completion rhythm is anchored ON its due date; a booking window is anchored at
  // its START, and what matters is when it closes — one cadence later.
  const landsOn = input.satisfiedBy === 'scheduling' ? addCadence(anchor, input.every) : anchor
  const { effectiveDays, capped } = nudgePlan(input.every, input.leadDays)
  const nudgeFrom = new Date(landsOn.getTime())
  nudgeFrom.setDate(nudgeFrom.getDate() - effectiveDays)
  return { landsOn, nudgeFrom, capped }
}

// ── Hooks ───────────────────────────────────────────────────────────────────────

export function useRhythms() {
  const [rhythms, setRhythms] = useState<RhythmWithPeriod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['rhythms'], refetch)
  useEffect(() => {
    let alive = true
    rhythmsApi.list()
      .then((d) => { if (alive) { setRhythms(d.rhythms ?? []); setError(false); setLoading(false) } })
      .catch(() => { if (alive) { setError(true); setLoading(false) } })
    return () => { alive = false }
  }, [nonce])
  return { rhythms, loading, error, refetch }
}

/**
 * What needs attention today. The horizon is deliberately today on every surface:
 * `to` doubles as the date that decides WHICH period a scheduling rhythm reports
 * on, so looking further ahead would answer about a later period.
 */
export function useRhythmAttention() {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['rhythms'], refetch)
  useEffect(() => {
    let alive = true
    rhythmsApi.attention(localToday())
      .then((d) => { if (alive) { setItems(d.items ?? []); setError(false); setLoading(false) } })
      .catch(() => { if (alive) { setError(true); setLoading(false) } })
    return () => { alive = false }
  }, [nonce])
  return { items, loading, error, refetch }
}
