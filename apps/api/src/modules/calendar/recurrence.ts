// Pure RRULE expansion — the heart of recurring events. Given a Nook-native master
// (its rrule/rdate/exdate + timezone) and its per-occurrence overrides, expand the
// series into concrete occurrences within a bounded window. No DB, no I/O — fully
// unit-testable. The expansion.service.ts worker calls this and persists the result
// into event_occurrences; clients never run this.
//
// DST correctness: we expand in the event's IANA timezone using the classic
// "floating then localize" technique. rrule.js works in a tz-naive (UTC-encoded
// wall-clock) domain; we (1) encode the master's local wall time as a floating
// Date, (2) let rrule walk the pattern, (3) re-localize each result back to an
// absolute instant in the master tz via luxon. So "9am daily" stays 9am local
// across a DST change instead of drifting an hour.
import { RRule } from 'rrule'
import { DateTime } from 'luxon'

export interface MasterEvent {
  rrule: string // the RRULE (with or without a leading "RRULE:")
  startsAt: Date // absolute instant of the first occurrence
  endsAt?: Date | null // absolute instant; defines the per-occurrence duration
  timezone: string // IANA, e.g. "America/Chicago"
  allDay?: boolean
  rdate?: Date[] | null // extra one-off occurrence instants
  exdate?: Date[] | null // cancelled occurrence instants (match the original start)
  recurrenceEndAt?: Date | null // hard stop; null = open-ended (bounded by the window)
  personId?: string | null
  title?: string | null
  location?: string | null
}

export interface OverrideRow {
  id: string
  originalStart: Date // which occurrence this overrides (the rule-generated slot)
  isCancelled: boolean
  startsAt?: Date | null // null → inherit the rule-generated start
  endsAt?: Date | null
  title?: string | null
  location?: string | null
}

export interface Occurrence {
  originalStart: Date // stable identity (the rule slot), even if moved by an override
  startsAt: Date // effective start
  endsAt: Date | null
  allDay: boolean
  personId: string | null
  title: string | null
  location: string | null
  overrideId: string | null
}

// Safety rail: a window should never yield more than this; protects against a
// pathological rule (e.g. SECONDLY) slipping through.
const MAX_OCCURRENCES = 2000

// Absolute instant → floating Date (UTC fields hold the local wall-clock in tz).
function toFloating(instant: Date, tz: string): Date {
  const dt = DateTime.fromJSDate(instant, { zone: tz })
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second))
}

// Floating Date → absolute instant (read the UTC fields as wall-clock in tz).
function fromFloating(floating: Date, tz: string): Date {
  return DateTime.fromObject(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
    },
    { zone: tz },
  ).toJSDate()
}

function localDayKey(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toISODate() ?? ''
}

/**
 * Expand a recurring master into occurrences whose start falls within
 * [windowStart, windowEnd] (inclusive). Applies rdate/exdate and overrides.
 */
export function expand(master: MasterEvent, overrides: OverrideRow[], windowStart: Date, windowEnd: Date): Occurrence[] {
  const tz = master.timezone || 'UTC'
  const durationMs = master.endsAt ? master.endsAt.getTime() - master.startsAt.getTime() : null

  // Build the rule in the floating domain.
  const ruleText = master.rrule.replace(/^RRULE:/i, '').trim()
  const opts = RRule.parseString(ruleText)
  opts.dtstart = toFloating(master.startsAt, tz)
  // recurrence_end_at clamps the series even if the rule itself is open-ended.
  if (master.recurrenceEndAt) {
    const endFloat = toFloating(master.recurrenceEndAt, tz)
    opts.until = opts.until && opts.until < endFloat ? opts.until : endFloat
  }
  const rule = new RRule(opts)

  // Walk the pattern across the window (floating), then re-localize each slot.
  const floats = rule.between(toFloating(windowStart, tz), toFloating(windowEnd, tz), true)
  const slots = floats.slice(0, MAX_OCCURRENCES).map((f) => fromFloating(f, tz))

  const overrideBy = new Map(overrides.map((o) => [o.originalStart.getTime(), o]))
  const exSet = new Set((master.exdate ?? []).map((d) => d.getTime()))

  const out: Occurrence[] = []
  const seen = new Set<number>()

  const push = (originalStart: Date) => {
    const key = originalStart.getTime()
    if (seen.has(key)) return
    if (exSet.has(key)) return
    const ov = overrideBy.get(key)
    if (ov?.isCancelled) {
      seen.add(key)
      return
    }
    const startsAt = ov?.startsAt ?? originalStart
    const endsAt = ov?.endsAt ?? (durationMs != null ? new Date(startsAt.getTime() + durationMs) : null)
    out.push({
      originalStart,
      startsAt,
      endsAt,
      allDay: master.allDay ?? false,
      personId: master.personId ?? null,
      title: ov?.title ?? master.title ?? null,
      location: ov?.location ?? master.location ?? null,
      overrideId: ov?.id ?? null,
    })
    seen.add(key)
  }

  for (const slot of slots) push(slot)

  // rdate are extra absolute occurrence instants (subject to the same window/overrides).
  for (const r of master.rdate ?? []) {
    if (r >= windowStart && r <= windowEnd) push(r)
  }

  out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return out
}

// Validate an RRULE string for the create/patch API: parseable and has a FREQ.
export function isValidRrule(rrule: string): boolean {
  try {
    const opts = RRule.parseString(rrule.replace(/^RRULE:/i, '').trim())
    return opts.freq !== undefined && opts.freq !== null
  } catch {
    return false
  }
}

export { toFloating, fromFloating, localDayKey }
