// Local heuristic parser for the "Add anything…" capture bar (roadmap 6.6).
// Zero external calls — turns free text into a structured intent the kiosk can
// commit to the right domain (event / grocery / task / meal). A Claude-backed
// upgrade can swap in later behind the same ParsedIntent shape.
//
// ⚠️ KEEP IN SYNC — this parser is mirrored on iOS at
//   apps/ios/Sources/Nook/Sync/CaptureHeuristic.swift
// (tests: apps/ios/Tests/CaptureHeuristicTests.swift ↔ this file's parse.test.ts).
// If you change a parsing RULE here, port the same change to the Swift file and
// update BOTH test suites so they stay byte-for-byte equivalent.
//
// Routing priority: a date/time → event; otherwise a grocery signal → grocery;
// otherwise a task signal → task; bare nouns fall back to grocery (the most
// common quick capture). `now` is injected so the logic is deterministic in tests.

import { describeRrule } from '../../kiosk/components/recurrence'

export type ParsedIntent =
  | { kind: 'event'; title: string; startsAt: string; allDay: boolean; personName: string | null; rrule: string | null; recurrenceEndAt?: string | null; scheduleLabel: string; whenLabel: string }
  | { kind: 'grocery'; name: string; quantity: string | null }
  | { kind: 'task'; title: string; personName: string | null; stars: number | null; rrule: string | null; scheduleLabel: string }
  | { kind: 'meal'; title: string; date: string | null; mealType: string; whenLabel: string }
  | { kind: 'list'; listName: string | null; itemName: string; quantity: string | null }
  | { kind: 'countdown'; title: string; date: string; emoji: string | null; whenLabel: string }
  | { kind: 'person'; name: string; memberType: string; avatarEmoji: string | null; birthday: string | null; isAdmin: boolean }
  | { kind: 'goal'; title: string; goalType: string; targetValue: number | null; unit: string | null; deadline: string | null; trackingMode: string; participantMode: string; targetBasis: string; participantIds: string[]; audience: 'me' | 'everyone' | null }
  | { kind: 'pantry'; name: string; amount: string | null; unit: string | null; location: string; expiresOn: string | null; lowAt: number | null }
  | { kind: 'reward'; title: string; emoji: string | null; cost: number | null; currency: string | null; category: string | null; requiresApproval: boolean | null }
  | { kind: 'unsupported'; reason: string }

// Member types for the `person` intent, and a human label for the preview.
export const MEMBER_TYPES = ['adult', 'teen', 'kid'] as const
export function memberTypeLabel(t: string): string {
  return t === 'kid' ? 'Kid' : t === 'teen' ? 'Teen' : 'Adult'
}

// Goal types for the `goal` intent, and a human label for the preview.
export const GOAL_TYPES = ['count', 'total', 'habit', 'checklist'] as const
export function goalTypeLabel(t: string): string {
  return t === 'count' ? 'Count' : t === 'total' ? 'Total' : t === 'checklist' ? 'Checklist' : 'Habit'
}

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack'])
function mealTypeFrom(word?: string): string {
  const w = (word ?? '').toLowerCase()
  if (w === 'supper') return 'dinner'
  if (w === 'brunch') return 'lunch'
  return MEAL_TYPES.has(w) ? w : 'dinner'
}
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
}
// iCalendar BYDAY codes, indexed by JS getDay() (0=Sun).
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
}

interface Span { start: number; end: number }
interface DayHit { y: number; mo: number; d: number; label: string; span: Span; eveningHint: boolean }
interface TimeHit { h: number; m: number; label: string; span: Span }

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

// Find a day reference: today/tomorrow/tonight, a weekday (optionally "next"),
// a month+day ("jun 5"), or a numeric date ("6/5").
function findDay(text: string, now: Date): DayHit | null {
  const base = startOfDay(now)
  const ymd = (d: Date, label: string, span: Span, eveningHint = false): DayHit => ({
    y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), label, span, eveningHint,
  })

  let m = /\b(today|tonight|tomorrow|this evening)\b/i.exec(text)
  if (m) {
    const word = m[1].toLowerCase()
    const evening = word === 'tonight' || word === 'this evening'
    const d = new Date(base)
    if (word === 'tomorrow') d.setDate(d.getDate() + 1)
    const label = word === 'tomorrow' ? 'Tomorrow' : evening ? 'Tonight' : 'Today'
    return ymd(d, label, { start: m.index, end: m.index + m[0].length }, evening)
  }

  m = /\b(next\s+)?(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)\b/i.exec(text)
  if (m) {
    const wd = WEEKDAYS[m[2].toLowerCase()]
    const d = new Date(base)
    let delta = (wd - d.getDay() + 7) % 7
    if (m[1]) delta += delta === 0 ? 7 : 7 // "next" pushes a full week out
    else if (delta === 0) delta = 0 // a bare weekday that is today = today
    d.setDate(d.getDate() + delta)
    const label = d.toLocaleDateString('en-US', { weekday: 'long' })
    return ymd(d, m[1] ? `Next ${label}` : label, { start: m.index, end: m.index + m[0].length })
  }

  m = /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text)
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()]
    const day = parseInt(m[2], 10)
    let year = now.getFullYear()
    if (mo < now.getMonth() || (mo === now.getMonth() && day < now.getDate())) year += 1
    const d = new Date(year, mo, day)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return ymd(d, label, { start: m.index, end: m.index + m[0].length })
  }

  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text)
  if (m) {
    const mo = parseInt(m[1], 10) - 1
    const day = parseInt(m[2], 10)
    if (mo >= 0 && mo <= 11 && day >= 1 && day <= 31) {
      let year = m[3] ? parseInt(m[3].length === 2 ? `20${m[3]}` : m[3], 10) : now.getFullYear()
      if (!m[3] && (mo < now.getMonth() || (mo === now.getMonth() && day < now.getDate()))) year += 1
      const d = new Date(year, mo, day)
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return ymd(d, label, { start: m.index, end: m.index + m[0].length })
    }
  }
  return null
}

// Every weekday mentioned, for chore recurrence ("Wednesday and Sunday night"
// → BYDAY=WE,SU). De-dupes codes but returns all spans so they're stripped.
function findAllWeekdays(text: string): { codes: string[]; spans: Span[]; labels: string[] } {
  const re = /\b(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)\b/gi
  const codes: string[] = []
  const labels: string[] = []
  const spans: Span[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const dow = WEEKDAYS[m[1].toLowerCase()]
    spans.push({ start: m.index, end: m.index + m[0].length })
    const code = BYDAY[dow]
    if (!seen.has(code)) {
      seen.add(code)
      codes.push(code)
      labels.push(DAY_SHORT[dow])
    }
  }
  return { codes, spans, labels }
}

// Recurrence for an EVENT ("soccer every Tuesday", "book club monthly", "standup
// every weekday"). Returns the rrule + the spans to strip from the title. A bare
// single weekday ("Tuesday") is a one-off date, NOT recurrence — only an explicit
// cue ("every", "weekly", a plural "Tuesdays") turns it into a rule. `startWeekday`
// anchors a generic "every week" to the event's own day.
function detectEventRecurrence(text: string, startWeekday: number): { rrule: string | null; spans: Span[] } {
  const spans: Span[] = []
  const add = (m: RegExpExecArray | null) => { if (m) spans.push({ start: m.index, end: m.index + m[0].length }) }

  // Daily / weekdays
  let m = /\b(every\s*day|everyday|daily|each\s*day)\b/i.exec(text)
  if (m) { add(m); return { rrule: 'FREQ=DAILY', spans } }
  m = /\b(every\s+)?weekdays?\b/i.exec(text)
  if (m && /\bevery\b/i.test(m[0])) { add(m); return { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', spans } }

  // Interval cue ("every other"/"biweekly", or "every N weeks/months/years")
  let interval = 1
  const other = /\b(every other|bi-?weekly|fortnightly)\b/i.exec(text)
  if (other) { interval = 2; add(other) }
  const everyN = /\bevery\s+(\d{1,2})\s+(day|week|month|year)s?\b/i.exec(text)
  if (everyN) { interval = Math.max(1, parseInt(everyN[1], 10)); add(everyN) }
  const unit = everyN ? everyN[2].toLowerCase() : null
  const iv = interval > 1 ? `;INTERVAL=${interval}` : ''

  if (unit === 'year' || /\b(yearly|annually|every year)\b/i.test(text)) {
    add(/\b(yearly|annually|every year)\b/i.exec(text))
    return { rrule: `FREQ=YEARLY${iv}`, spans }
  }
  if (unit === 'month' || /\b(monthly|every month)\b/i.test(text)) {
    add(/\b(monthly|every month)\b/i.exec(text))
    return { rrule: `FREQ=MONTHLY${iv}`, spans }
  }

  // Weekly with explicit day(s): only in a recurring context — "every tuesday",
  // "tuesdays" (plural), "weekly on tuesday", "every other monday".
  const recurringCtx = !!other || !!everyN || /\bevery\b/i.test(text) || /\bweekly\b/i.test(text)
  const re = /\b(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)(s)?\b/gi
  const days: string[] = []
  const seen = new Set<string>()
  let w: RegExpExecArray | null
  while ((w = re.exec(text))) {
    const plural = !!w[2]
    if (!recurringCtx && !plural) continue // a lone weekday is a date, handled by findDay
    const code = BYDAY[WEEKDAYS[w[1].toLowerCase()]]
    spans.push({ start: w.index, end: w.index + w[0].length })
    if (!seen.has(code)) { seen.add(code); days.push(code) }
  }
  if (days.length) return { rrule: `FREQ=WEEKLY${iv};BYDAY=${days.join(',')}`, spans }

  // Generic "every week" / "weekly" → the event's own weekday.
  if (unit === 'week' || /\b(weekly|every week)\b/i.test(text)) {
    add(/\b(weekly|every week)\b/i.exec(text))
    return { rrule: `FREQ=WEEKLY${iv};BYDAY=${BYDAY[startWeekday]}`, spans }
  }
  return { rrule: null, spans }
}

function findTime(text: string): TimeHit | null {
  let m = /\b(noon|midnight)\b/i.exec(text)
  if (m) {
    const noon = m[1].toLowerCase() === 'noon'
    return { h: noon ? 12 : 0, m: 0, label: noon ? '12:00 PM' : '12:00 AM', span: { start: m.index, end: m.index + m[0].length } }
  }
  // 3pm, 3:30pm, 12 pm — optionally with a leading "at" so it gets stripped too.
  m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (m) {
    let h = parseInt(m[1], 10) % 12
    if (m[3].toLowerCase() === 'pm') h += 12
    const min = m[2] ? parseInt(m[2], 10) : 0
    return { h, m: min, label: fmtTime(h, min), span: { start: m.index, end: m.index + m[0].length } }
  }
  // "at 4" or "at 16:00"
  m = /\bat\s+(\d{1,2})(?::(\d{2}))?\b/i.exec(text)
  if (m) {
    let h = parseInt(m[1], 10)
    const min = m[2] ? parseInt(m[2], 10) : 0
    if (h < 7 && !m[2]) h += 12 // "at 4" almost always means the afternoon
    if (h > 23 || min > 59) return null
    return { h, m: min, label: fmtTime(h, min), span: { start: m.index, end: m.index + m[0].length } }
  }
  return null
}

function fmtTime(h: number, m: number): string {
  const ap = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`
}

// Match "for <Person>" or a bare known name; returns the person and the span to strip.
function findPerson(text: string, persons: string[]): { name: string; span: Span } | null {
  for (const p of persons) {
    const re = new RegExp(`\\bfor\\s+${escapeRe(p)}\\b`, 'i')
    const m = re.exec(text)
    if (m) return { name: p, span: { start: m.index, end: m.index + m[0].length } }
  }
  for (const p of persons) {
    // Also match a possessive ("Kelly's chore list") and consume the 's.
    const re = new RegExp(`\\b${escapeRe(p)}(?:['’]s)?\\b`, 'i')
    const m = re.exec(text)
    if (m) return { name: p, span: { start: m.index, end: m.index + m[0].length } }
  }
  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cut(text: string, spans: Span[]): string {
  const sorted = [...spans].filter(Boolean).sort((a, b) => b.start - a.start)
  let out = text
  for (const s of sorted) out = out.slice(0, s.start) + ' ' + out.slice(s.end)
  return out
}

function tidy(s: string): string {
  return s
    .replace(/^\s*(?:\b(?:at|on|for|the|a|an|to)\b\s*)+/i, '') // drop a leading run of filler words
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.–-]+|[\s,.!?–-]+$/g, '')
    .trim()
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

const GROCERY_VERB = /^\s*(add|buy|get|grab|need|pick up|picking up|purchase)\b/i
const GROCERY_TO_LIST = /\bto\s+(the\s+)?(grocery\s+|shopping\s+)?list\b/i
const GROCERY_UNIT = /\b\d+\s?(lb|lbs|oz|ozs|g|kg|gal|gallon|gallons|dozen|bunch|bunches|can|cans|box|boxes|bag|bags|bottle|bottles|pack|packs|jar|jars|loaf|loaves|carton|cartons)\b/i
const TASK_SIGNAL = /^\s*(remind|remember to|todo|to-do|task)\b/i
const CHORE_WORD = /\bchore\b/i

// Pull a leading quantity ("2 lbs", "a dozen", "3") off a grocery phrase.
function splitQuantity(s: string): { quantity: string | null; name: string } {
  const m = /^\s*(\d+(?:\.\d+)?\s?(?:lb|lbs|oz|ozs|g|kg|gal|gallon|gallons|dozen|bunch|bunches|can|cans|box|boxes|bag|bags|bottle|bottles|pack|packs|jar|jars|loaf|loaves|carton|cartons)?|a\s+dozen|a\s+couple)\b/i.exec(s)
  if (m) {
    const name = s.slice(m.index + m[0].length).replace(/^\s*(of\s+)?/i, '').trim()
    if (name) return { quantity: m[1].trim().replace(/^a\s+/i, ''), name }
  }
  return { quantity: null, name: s.trim() }
}

// Token-overlap match of free text against a known list name ("the lake packing
// trip" → "Lake trip packing"). Returns the canonical list name or null.
function matchKnownList(text: string, lists: string[]): string | null {
  // Keep meaningful nouns like "trip"/"packing" — only drop true filler words —
  // so "my lake trip" still matches "Lake trip packing".
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an|my|our|list|to|for)\b/g, ' ').replace(/\s+/g, ' ').trim()
  const ttoks = new Set(norm(text).split(' ').filter(Boolean))
  let best: { name: string; score: number } | null = null
  for (const l of lists) {
    const ltoks = norm(l).split(' ').filter(Boolean)
    if (!ltoks.length) continue
    const inter = ltoks.filter((t) => ttoks.has(t)).length
    const score = inter / ltoks.length
    if (score >= 0.6 && (!best || score > best.score)) best = { name: l, score }
  }
  return best?.name ?? null
}

// COUNTDOWN — a future day to count down to, with NO clock time. Triggers:
// "N days until X", "X in N days", "countdown to X [on <date>]", "N sleeps until X".
// A clock time means it's a scheduled event, not a day marker, so we bail then.
const CD_UNTIL = /^\s*(\d{1,3})\s+(?:days?|sleeps?)\s+(?:until|til|till|to|before)\s+(.+)$/i
const CD_IN = /^(.+?)\s+in\s+(\d{1,3})\s+(?:days?|sleeps?)\s*$/i
const CD_TO = /\bcountdown\s+(?:to|until|til|till|for)\s+(.+)$/i

// ── Holidays ──────────────────────────────────────────────────────────────────
// Resolve a known holiday name to its NEXT occurrence on/after startOfDay(now).
// KEEP IN SYNC with the Swift `findHoliday` and the server `resolveDayFromText`.
interface HolidayHit { date: Date; label: string; span: Span }

function nthWeekdayOfMonth(year: number, month0: number, weekday: number, n: number): Date {
  const first = new Date(year, month0, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  return new Date(year, month0, 1 + offset + (n - 1) * 7)
}
function lastWeekdayOfMonth(year: number, month0: number, weekday: number): Date {
  const last = new Date(year, month0 + 1, 0) // day 0 of next month = last day of this one
  const offset = (last.getDay() - weekday + 7) % 7
  return new Date(year, month0, last.getDate() - offset)
}
function easterSunday(year: number): Date {
  // Anonymous Gregorian algorithm (Computus).
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const mth = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * mth + 114) / 31) // 3=Mar, 4=Apr
  const day = ((h + l - 7 * mth + 114) % 31) + 1
  return new Date(year, month - 1, day)
}
function shiftDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

const HOLIDAYS: { re: RegExp; label: string; calc: (y: number) => Date }[] = [
  { re: /\bnew\s+year'?s?\s+eve\b/i, label: "New Year's Eve", calc: (y) => new Date(y, 11, 31) },
  { re: /\bnew\s+year'?s?(?:\s+day)?\b/i, label: "New Year's Day", calc: (y) => new Date(y, 0, 1) },
  { re: /\bvalentine'?s?(?:\s+day)?\b/i, label: "Valentine's Day", calc: (y) => new Date(y, 1, 14) },
  { re: /\bst\.?\s+patrick'?s?(?:\s+day)?\b/i, label: "St. Patrick's Day", calc: (y) => new Date(y, 2, 17) },
  { re: /\bcinco\s+de\s+mayo\b/i, label: 'Cinco de Mayo', calc: (y) => new Date(y, 4, 5) },
  { re: /\bjuneteenth\b/i, label: 'Juneteenth', calc: (y) => new Date(y, 5, 19) },
  { re: /\b(?:independence\s+day|july\s+4th|july\s+4|4th\s+of\s+july|fourth\s+of\s+july)\b/i, label: 'Independence Day', calc: (y) => new Date(y, 6, 4) },
  { re: /\bhalloween\b/i, label: 'Halloween', calc: (y) => new Date(y, 9, 31) },
  { re: /\bveterans'?\s+day\b/i, label: 'Veterans Day', calc: (y) => new Date(y, 10, 11) },
  { re: /\bchristmas\s+eve\b/i, label: 'Christmas Eve', calc: (y) => new Date(y, 11, 24) },
  { re: /\b(?:christmas|xmas)\b/i, label: 'Christmas', calc: (y) => new Date(y, 11, 25) },
  { re: /\bmlk(?:\s+day)?\b|\bmartin\s+luther\s+king(?:\s+jr\.?)?(?:\s+day)?\b/i, label: 'MLK Day', calc: (y) => nthWeekdayOfMonth(y, 0, 1, 3) },
  { re: /\bpresidents'?\s+day\b/i, label: "Presidents' Day", calc: (y) => nthWeekdayOfMonth(y, 1, 1, 3) },
  { re: /\bmother'?s?\s+day\b/i, label: "Mother's Day", calc: (y) => nthWeekdayOfMonth(y, 4, 0, 2) },
  { re: /\bmemorial\s+day\b/i, label: 'Memorial Day', calc: (y) => lastWeekdayOfMonth(y, 4, 1) },
  { re: /\bfather'?s?\s+day\b/i, label: "Father's Day", calc: (y) => nthWeekdayOfMonth(y, 5, 0, 3) },
  { re: /\blabor\s+day\b/i, label: 'Labor Day', calc: (y) => nthWeekdayOfMonth(y, 8, 1, 1) },
  { re: /\bthanksgiving\b/i, label: 'Thanksgiving', calc: (y) => nthWeekdayOfMonth(y, 10, 4, 4) },
  { re: /\bgood\s+friday\b/i, label: 'Good Friday', calc: (y) => shiftDays(easterSunday(y), -2) },
  { re: /\beaster\b/i, label: 'Easter', calc: (y) => easterSunday(y) },
]

function findHoliday(text: string, now: Date): HolidayHit | null {
  const base = startOfDay(now)
  let best: HolidayHit | null = null
  for (const h of HOLIDAYS) {
    const m = h.re.exec(text)
    if (!m) continue
    let date = h.calc(now.getFullYear())
    if (startOfDay(date).getTime() < base.getTime()) date = h.calc(now.getFullYear() + 1)
    const span = { start: m.index, end: m.index + m[0].length }
    // Prefer the earliest match in the text (so a preceding word wins), which also
    // makes "Christmas Eve" beat "Christmas" when both start at the same index.
    if (!best || span.start < best.span.start) best = { date, label: h.label, span }
  }
  return best
}

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function addDaysFrom(now: Date, n: number): Date {
  const d = startOfDay(now)
  d.setDate(d.getDate() + n)
  return d
}
function countdownWhen(target: Date, now: Date): string {
  const days = Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / 86_400_000)
  const dayLabel = target.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const rel = days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`
  return `${dayLabel} · ${rel}`
}
function detectCountdown(text: string, now: Date): Extract<ParsedIntent, { kind: 'countdown' }> | null {
  if (findTime(text)) return null // a clock time → schedule an event instead
  let titleRaw: string | null = null
  let target: Date | null = null

  let m = CD_UNTIL.exec(text)
  if (m) { target = addDaysFrom(now, parseInt(m[1], 10)); titleRaw = m[2] }
  if (!titleRaw) {
    m = CD_IN.exec(text)
    if (m) { target = addDaysFrom(now, parseInt(m[2], 10)); titleRaw = m[1] }
  }
  if (!titleRaw) {
    m = CD_TO.exec(text)
    if (m) {
      titleRaw = m[1]
      // "countdown to X on <date>" — pull an explicit day out of the tail.
      const dh = findDay(titleRaw, now)
      if (dh) {
        target = new Date(dh.y, dh.mo, dh.d)
        titleRaw = cut(titleRaw, [dh.span]).replace(/\b(?:on|to)\s*$/i, '')
      } else {
        // No explicit day — try a holiday name ("countdown for thanksgiving").
        const hh = findHoliday(titleRaw, now)
        if (hh) {
          target = hh.date
          const remaining = tidy(cut(titleRaw, [hh.span]))
          titleRaw = remaining || hh.label
        }
      }
    }
  }
  if (!titleRaw || !target) return null
  const title = titleCase(tidy(titleRaw)) || 'Countdown'
  return { kind: 'countdown', title, date: ymdLocal(target), emoji: null, whenLabel: countdownWhen(target, now) }
}

// PERSON — add a new household member. Triggers: "add my son/daughter/husband/…
// <name>", "add a family member <name>", "create a profile for <name>". MINIMAL
// heuristic (plan §5): name + memberType + safe defaults; the LLM upgrade fills
// avatarEmoji/birthday/isAdmin. Relationship word → memberType.
const REL_KID = 'son|daughter|kid|child|boy|girl|baby'
const REL_TEEN = 'teenager|teen'
const REL_ADULT = 'husband|wife|spouse|partner|mom|mum|mommy|mother|dad|daddy|father|parent|adult|grandma|grandpa|grandmother|grandfather'
const PERSON_REL = new RegExp(`\\b(?:add|create|make|register)\\s+(?:my|our|a|an|the)?\\s*(?:new\\s+)?(${REL_KID}|${REL_TEEN}|${REL_ADULT})\\b[\\s,:-]*(?:named\\s+|called\\s+)?(.+)$`, 'i')
const PERSON_MEMBER = /\b(?:add|create|make|register)\s+(?:a\s+|an\s+|the\s+|my\s+|our\s+)?(?:new\s+)?(?:family\s+member|household\s+member|family\s+profile|profile|person|member)\b\s*(?:for\s+|named\s+|called\s+|[:-]\s*)?(.+)$/i

function memberTypeForRel(word: string): string {
  const w = word.toLowerCase()
  if (new RegExp(`^(?:${REL_KID})$`, 'i').test(w)) return 'kid'
  if (new RegExp(`^(?:${REL_TEEN})$`, 'i').test(w)) return 'teen'
  return 'adult'
}

// Strip a trailing ", age 8" / "aged 8" (age maps to nothing today — no birthday),
// then clean to a bare name.
function cleanPersonName(raw: string): string {
  const noAge = raw.replace(/[\s,]+(?:who\s+is\s+|aged?\s+)\d{1,3}\b.*$/i, '')
  return titleCase(tidy(noAge))
}

function detectPerson(text: string): Extract<ParsedIntent, { kind: 'person' }> | null {
  // A clock time or an explicit date signals scheduling, not a profile.
  if (findTime(text)) return null
  const rel = PERSON_REL.exec(text)
  if (rel) {
    const name = cleanPersonName(rel[2])
    if (name) return { kind: 'person', name, memberType: memberTypeForRel(rel[1]), avatarEmoji: null, birthday: null, isAdmin: false }
  }
  const mem = PERSON_MEMBER.exec(text)
  if (mem) {
    const name = cleanPersonName(mem[1])
    if (name) return { kind: 'person', name, memberType: 'adult', avatarEmoji: null, birthday: null, isAdmin: false }
  }
  return null
}

// GOAL — a personal/shared goal. Triggers: "set a goal to…", "I want to…",
// "my goal is (to)…", "new goal: …". An optional adjective (or two) can sit between
// the article/pronoun and "goal" — "set a personal goal", "set a new goal", "set
// myself a big goal", "set our family goal", "set a weekly goal" — so the anchor is
// "goal", not "a goal". The offline heuristic then infers the target/unit/deadline
// (below). Mirrors `detectGoal` in CaptureHeuristic.swift.
const GOAL_TRIGGER = /^\s*(?:set(?:ting)?\s+(?:a\s+|an\s+|the\s+|our\s+|my\s+|myself\s+a\s+|myself\s+|us\s+a\s+|us\s+)?(?:[a-z]+\s+){0,3}?goal\s+(?:to|of|:)\s+|add\s+(?:a\s+|an\s+|the\s+|our\s+|my\s+)?(?:[a-z]+\s+){0,3}?goal\s+(?:to\s+|of\s+)?|(?:i|we)\s+want\s+to\s+|(?:i|we)['’]d\s+like\s+to\s+|my\s+goal\s+is\s+(?:to\s+)?|our\s+goal\s+is\s+(?:to\s+)?|new\s+goal\s*[:-]\s*)(.+)$/i

// Units that ACCUMULATE (a measured/split amount) → a `total` goal; anything else
// countable ("books", "workouts", "glasses") → a `count` goal. Mirrors the Swift set.
const GOAL_TOTAL_UNIT = /^(?:miles?|mi|kilometers?|km|meters?|m|lbs?|pounds?|kgs?|kilograms?|kilos?|ounces?|oz|grams?|g|hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|days?|weeks?|dollars?|usd|bucks?|cents?|gallons?|gal|liters?|litres?|l|calories?|cals?|cal|steps?|reps?|points?|pts?)$/i

// Pull a numeric target + its unit out of a goal phrase. A currency symbol before the
// number ("$500") → dollars/total; otherwise "<number> <word>" where the word decides
// count vs total. Returns the span to strip from the title. Mirrors the Swift helper.
function goalMeasure(text: string): { targetValue: number; unit: string; goalType: string; span: Span } | null {
  const cur = /(\$)\s?(\d+(?:\.\d+)?)/.exec(text)
  if (cur) return { targetValue: parseFloat(cur[2]), unit: 'dollars', goalType: 'total', span: { start: cur.index, end: cur.index + cur[0].length } }
  const m = /(\d+(?:\.\d+)?)\s+([A-Za-z]+)/.exec(text)
  if (m) {
    const unit = m[2].toLowerCase()
    const goalType = GOAL_TOTAL_UNIT.test(unit) ? 'total' : 'count'
    return { targetValue: parseFloat(m[1]), unit, goalType, span: { start: m.index, end: m.index + m[0].length } }
  }
  return null
}

// Resolve a goal deadline from "by <when>" / "this year|month". "by september" (a bare
// month) → the last day of that month's next occurrence; "by Friday" / "by Dec 1" /
// "by 12/1" → the resolved day (via findDay). Returns the span to strip. Mirrors Swift.
function goalDeadline(text: string, now: Date): { date: string; start: number; end: number } | null {
  const ty = /\b(?:by\s+|before\s+)?(?:the\s+end\s+of\s+)?this\s+(year|month)\b/i.exec(text)
  if (ty) {
    const d = ty[1].toLowerCase() === 'year' ? new Date(now.getFullYear(), 11, 31) : new Date(now.getFullYear(), now.getMonth() + 1, 0)
    return { date: ymdLocal(d), start: ty.index, end: ty.index + ty[0].length }
  }
  const bm = /\bby\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i.exec(text)
  if (bm && !/^\s*\d/.test(text.slice(bm.index + bm[0].length))) {
    const mo = MONTHS[bm[1].toLowerCase()]
    let year = now.getFullYear()
    if (mo < now.getMonth()) year += 1
    const d = new Date(year, mo + 1, 0) // day 0 of the next month = the last day of this one
    return { date: ymdLocal(d), start: bm.index, end: bm.index + bm[0].length }
  }
  const by = /\bby\s+/i.exec(text)
  if (by) {
    const afterStart = by.index + by[0].length
    const dh = findDay(text.slice(afterStart), now)
    if (dh) return { date: ymdLocal(new Date(dh.y, dh.mo, dh.d)), start: by.index, end: afterStart + dh.span.end }
  }
  return null
}

// Infer who the goal is for from the phrasing — the same word-driven inference the rest
// of the bar does. "family"/"our"/"together"/"we want"/… → the whole household ('everyone');
// "personal"/"my own"/"i want to"/… → just the author ('me'); no hint → null (defaults to
// Just me in the picker). The 'everyone' cues win when both are present. Mirrors the Swift
// `goalAudience`.
function goalAudience(text: string): 'me' | 'everyone' | null {
  if (/\b(family|our|everyone|shared|as a family|together|us|we want)\b/i.test(text)) return 'everyone'
  if (/\b(personal|my own|for myself|my goal|i want to|i['’]d like to)\b/i.test(text)) return 'me'
  return null
}

function detectGoal(text: string, now: Date): Extract<ParsedIntent, { kind: 'goal' }> | null {
  const m = GOAL_TRIGGER.exec(text)
  if (!m) return null
  let body = m[1]
  // Deadline first (so a trailing "by september" doesn't get read as a target unit),
  // then the number + unit — stripping each phrase out of the title as we go.
  let deadline: string | null = null
  const dl = goalDeadline(body, now)
  if (dl) { deadline = dl.date; body = `${body.slice(0, dl.start)} ${body.slice(dl.end)}` }
  let goalType = 'habit'
  let targetValue: number | null = null
  let unit: string | null = null
  const meas = goalMeasure(body)
  if (meas) {
    goalType = meas.goalType
    targetValue = meas.targetValue
    unit = meas.unit
    body = `${body.slice(0, meas.span.start)} ${body.slice(meas.span.end)}`
  }
  const title = titleCase(tidy(body))
  if (!title) return null
  // Assignment defaults to a just-me shared total; the preview's "who's it for" control
  // fills participantIds (empty = the current viewer, resolved at commit). `audience` is
  // the inferred who-hint that seeds that control (everyone vs just me).
  return { kind: 'goal', title, goalType, targetValue, unit, deadline, trackingMode: 'shared_total', participantMode: 'count_once', targetBasis: 'family', participantIds: [], audience: goalAudience(text) }
}

// PANTRY — an item you ALREADY HAVE on hand, named with an explicit pantry/fridge/
// freezer destination: "add X to (the) pantry", "put X in the fridge/freezer",
// "we have X in the pantry". This is what distinguishes it from `grocery` (something
// to BUY — the shopping list): a bare "add milk" or "add milk to the shopping list"
// stays grocery; only an explicit pantry/fridge/freezer target routes here. FULL
// heuristic (plan §5). Mirrors `detectPantry` in CaptureHeuristic.swift.
const PANTRY_TARGET = /\b(?:to|in|into|inside)\s+(?:the\s+|my\s+|our\s+)?(pantry|fridge|freezer|refrigerator)\b/i
const PANTRY_LEAD = /^\s*(?:please\s+|kindly\s+|can you\s+)?(?:we\s+have\s+|i\s+have\s+|there(?:'s|\s+is|\s+are)\s+|add|put|throw|toss|drop|stock|store|stick|need|get|grab)?\s*(.+?)\s+(?:to|in|into|inside)\s+(?:the\s+|my\s+|our\s+)?(?:pantry|fridge|freezer|refrigerator)\b/i

function pantryLocation(word: string): string {
  const w = word.toLowerCase()
  if (w === 'fridge' || w === 'refrigerator') return 'Fridge'
  if (w === 'freezer') return 'Freezer'
  return 'Pantry'
}

// Split a leading quantity into a numeric amount + its unit ("2 cans of beans" →
// {amount:"2", unit:"cans", name:"beans"}). Reuses the grocery splitQuantity, then
// separates the number from the unit — pantry keeps them in distinct fields.
function splitAmountUnit(s: string): { amount: string | null; unit: string | null; name: string } {
  const { quantity, name } = splitQuantity(s)
  if (!quantity) return { amount: null, unit: null, name }
  const qm = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(quantity)
  if (qm) return { amount: qm[1], unit: qm[2].trim() || null, name }
  return { amount: quantity, unit: null, name }
}

function detectPantry(text: string): Extract<ParsedIntent, { kind: 'pantry' }> | null {
  const loc = PANTRY_TARGET.exec(text)
  if (!loc) return null
  const location = pantryLocation(loc[1])
  const im = PANTRY_LEAD.exec(text)
  const basis = tidy(im ? im[1] : text)
  const { amount, unit, name } = splitAmountUnit(basis)
  const itemName = titleCase(name)
  if (!itemName) return null
  return { kind: 'pantry', name: itemName, amount, unit, location, expiresOn: null, lowAt: null }
}

// REWARD — a reward-shop item kids can spend stars/points on. Triggers on the explicit
// word "reward": "add a reward: <title> for N stars", "new reward <title> costs N points",
// "reward: <title>". Pulls the numeric star/point cost. FULL heuristic (plan §5). Mirrors
// `detectReward` in CaptureHeuristic.swift. The offline path can't know the household's
// currency/category/approval default, so those stay null (the LLM/route fill them).
const REWARD_WORD = /\breward\b/i
const REWARD_LEAD = /^\s*(?:please\s+|kindly\s+|can you\s+)?(?:add|create|make|set\s*up|new|give)?\s*(?:a\s+|an\s+|the\s+)?(?:new\s+)?reward\b[\s:—-]*(?:called\s+|named\s+|for\s+|entitled\s+)?(.*)$/i
// A star/point price, either introduced ("for/costs/worth/at 50 stars") or trailing
// ("50 points"). Group 1 or 2 holds the number.
const REWARD_COST = /\b(?:for|costs?|worth|priced\s+at|at|=)\s+(\d{1,6})\s*(?:stars?|points?|pts?|coins?)?\b|\b(\d{1,6})\s*(?:stars?|points?|pts?|coins?)\b/i

function detectReward(text: string): Extract<ParsedIntent, { kind: 'reward' }> | null {
  if (!REWARD_WORD.test(text)) return null
  const lead = REWARD_LEAD.exec(text)
  let basis = lead ? lead[1] : text
  // Pull the cost out of the title basis (it may trail the name).
  let cost: number | null = null
  const cm = REWARD_COST.exec(basis)
  if (cm) {
    cost = parseInt(cm[1] ?? cm[2], 10)
    basis = `${basis.slice(0, cm.index)} ${basis.slice(cm.index + cm[0].length)}`
  }
  // Drop a dangling price lead-in left behind ("… for", "… costs").
  basis = basis.replace(/\b(?:for|costs?|worth|priced\s+at|at)\s*$/i, '')
  const title = titleCase(tidy(basis))
  if (!title) return null
  return { kind: 'reward', title, emoji: null, cost, currency: null, category: null, requiresApproval: null }
}

export function parseCapture(raw: string, persons: string[] = [], now: Date = new Date(), lists: string[] = []): ParsedIntent | null {
  const text = raw.trim()
  if (!text) return null

  const person = findPerson(text, persons)

  // PERSON — "add my son Max" / "add a family member Jane". A specific create phrase,
  // so it wins over the generic grocery/event fallbacks. Minimal: name + memberType.
  const personIntent = detectPerson(text)
  if (personIntent) return personIntent

  // GOAL — "set a goal to read 20 books" / "I want to get in shape". An explicit goal
  // phrase, so it wins over the grocery/task fallbacks. Minimal: title + habit default.
  const goalIntent = detectGoal(text, now)
  if (goalIntent) return goalIntent

  // REWARD — "add a reward: ice cream night for 50 stars". The explicit word "reward"
  // is a specific create phrase, so it wins over the grocery/task fallbacks.
  const rewardIntent = detectReward(text)
  if (rewardIntent) return rewardIntent

  // TASK / CHORE — an explicit "chore"/"task"/"remind" word wins over the date
  // heuristics, because a chore can carry a *recurring* schedule (weekday names
  // → a weekly rrule), which would otherwise be misread as an event datetime.
  if (TASK_SIGNAL.test(text) || CHORE_WORD.test(text)) {
    // A quoted phrase is the title, verbatim — so a word like "chore" *inside*
    // it isn't mistaken for the type keyword. Schedule/person/stars are read from
    // the text *outside* the quote.
    const quote = /["“]([^"”]+)["”]/.exec(text)
    const rest = quote ? `${text.slice(0, quote.index)} ${text.slice(quote.index + quote[0].length)}` : text

    const wd = findAllWeekdays(rest)
    const dailyRe = /\b(every\s*day|everyday|daily|each\s*day)\b/i
    let rrule: string | null = null
    let scheduleLabel = ''
    if (dailyRe.test(rest)) {
      rrule = 'FREQ=DAILY'
      scheduleLabel = 'Every day'
    } else if (wd.codes.length) {
      rrule = `FREQ=WEEKLY;BYDAY=${wd.codes.join(',')}`
      scheduleLabel = wd.labels.join(' & ')
    }
    const starM = /\b(\d{1,2})\s*stars?\b/i.exec(rest)
    const stars = starM ? parseInt(starM[1], 10) : null
    const personHit = findPerson(rest, persons)

    let title: string
    if (quote) {
      // Verbatim, minus a trailing "as a chore/task" descriptor.
      title = titleCase(quote[1].replace(/\s+as\s+an?\s+(chores?|tasks?)\b/i, '').replace(/\s{2,}/g, ' ').trim()) || 'Task'
    } else {
      const spans = [personHit?.span, ...wd.spans, starM ? { start: starM.index, end: starM.index + starM[0].length } : undefined].filter(Boolean) as Span[]
      const t = cut(rest, spans)
        // A trailing "to (the) chore/grocery/to-do list" is a destination, not the title.
        .replace(/\bto\s+(?:the\s+)?(?:chores?|tasks?|grocery|shopping|to-?do)?\s*lists?\b.*$/i, '')
        // Leading command lead-in: "please add/make …", "remind me to …".
        .replace(/^\s*(?:please\s+|kindly\s+)?(?:add|make|create|set\s*up|give|new|put|remind\w*|remember\s+to)\b/i, '')
        // "(a) chore to …" / "task: …".
        .replace(/^\s*(?:an?\s+)?(?:chores?|tasks?)\b[:\s]+(?:to\s+|for\s+)?/i, '')
        .replace(/^\s*to\s+/i, '')
        .replace(dailyRe, '')
        .replace(/\b(night|nights|evening|evenings|morning|mornings|tonight)\b/gi, '')
        .replace(/\b(?:every|each|worth|and)\b/gi, '')
        .replace(/\s*,\s*/g, ' ') // collapse the commas left by a stripped day list
        .replace(/\b(?:for|on|to|with)\s+(?=\s|$)/gi, ' ') // drop a dangling preposition
        .replace(/\b(?:for|on|to|with)\s*$/i, '')
      title = titleCase(tidy(t)) || 'Task'
    }
    return { kind: 'task', title, personName: personHit?.name ?? null, stars, rrule, scheduleLabel }
  }

  // MEAL — "meal plan" / "on the menu" phrasing, or "<dish> for dinner/lunch".
  // Beats the event branch so "tacos for dinner Friday" plans a meal, not an event.
  const mealPhrase = /\b(meal\s*plan|on the menu|dinner menu)\b/i.test(text)
  const forMeal = /\bfor\s+(dinner|lunch|breakfast|supper|brunch)\b/i.exec(text)
  const eatOut = /\b(eat|eating|dining|going)\s*out\b|\btake\s*-?out\b|\border(?:ing)?\s+in\b|\bdelivery\b|\btakeaway\b/i.test(text)
  if (mealPhrase || ((forMeal || eatOut) && !findTime(text))) {
    const mealType = mealTypeFrom(forMeal?.[1])
    const mDay = findDay(text, now)
    const date = mDay ? `${mDay.y}-${String(mDay.mo + 1).padStart(2, '0')}-${String(mDay.d).padStart(2, '0')}` : null
    if (eatOut) {
      return { kind: 'meal', title: 'Eating out', date, mealType, whenLabel: `${mDay ? mDay.label : 'Today'} · ${cap(mealType)}` }
    }
    const spans = [mDay?.span, forMeal ? { start: forMeal.index, end: forMeal.index + forMeal[0].length } : undefined].filter(Boolean) as Span[]
    const t = cut(text, spans)
      .replace(/\b(?:on|to|onto|in)\s+(?:the\s+)?(?:meal\s*plan|menu|dinner menu)\b/gi, '')
      .replace(/\b(?:meal\s*plan|on the menu|dinner menu)\b/gi, '')
      .replace(/^\s*(?:please\s+|kindly\s+|let'?s?\s+|can we\s+|i\s+want\s+(?:to\s+)?)?(?:put|add|plan|make|do|have|cook|throw|schedule)\b/i, '')
      .replace(/\b(?:please|kindly)\b/gi, '')
    const title = titleCase(tidy(t)) || 'Meal'
    return { kind: 'meal', title, date, mealType, whenLabel: `${mDay ? mDay.label : 'Today'} · ${cap(mealType)}` }
  }

  // LIST — "add X to (the) <named list>" / "put X on my <list>" for a NON-grocery
  // list. Matches a known list (token overlap) or a generic "… <name> list".
  let listName = matchKnownList(text, lists)
  if (!listName) {
    const g = /\b(?:to|on|onto|in)\s+(?:the\s+|my\s+|our\s+)?([a-z0-9][a-z0-9 ]*?)\s+list\b/i.exec(text)
    if (g && !/^(grocery|shopping|to-?do)\s*$/i.test(g[1].trim())) listName = titleCase(g[1].trim())
  }
  if (listName) {
    const im = /^\s*(?:please\s+|kindly\s+|can you\s+)?(?:add|put|throw|toss|drop|need|get|grab)?\s*(.+?)\s+(?:to|on|onto|in)\s+(?:the\s+|my\s+|our\s+)?/i.exec(text)
    const { quantity, name } = splitQuantity(tidy(im ? im[1] : text))
    const itemName = titleCase(name)
    if (itemName) return { kind: 'list', listName, itemName, quantity }
  }

  // COUNTDOWN — a day marker ("12 days until Disney"). Before the event branch so an
  // explicit "countdown to X on <date>" isn't swallowed as a plain dated event.
  const countdown = detectCountdown(text, now)
  if (countdown) return countdown

  const day = findDay(text, now)
  const time = findTime(text)
  const startWeekday = day ? new Date(day.y, day.mo, day.d).getDay() : now.getDay()
  const rec = detectEventRecurrence(text, startWeekday)

  // EVENT — a concrete day/time, or a recurrence cue (which anchors itself).
  if (day || time || rec.rrule) {
    let target: Date
    if (day) target = new Date(day.y, day.mo, day.d)
    else if (rec.rrule) {
      // No explicit day: anchor weekly-with-days at the next matching weekday,
      // everything else at today.
      const bd = /FREQ=WEEKLY[^]*BYDAY=([A-Z]{2})/.exec(rec.rrule)
      const base = startOfDay(now)
      if (bd) {
        const delta = (BYDAY.indexOf(bd[1]) - base.getDay() + 7) % 7
        target = new Date(base)
        target.setDate(base.getDate() + delta)
      } else target = base
    } else target = startOfDay(now)

    let allDay = true
    if (time) {
      target.setHours(time.h, time.m, 0, 0)
      allDay = false
    } else if (day?.eveningHint) {
      target.setHours(18, 0, 0, 0)
      allDay = false
    }
    const spans = [day?.span, time?.span, person?.span, ...rec.spans].filter(Boolean) as Span[]
    let titleRaw = cut(text, spans)
    // A lone "every"/"each"/"and"/"on" can survive next to the stripped weekday.
    if (rec.rrule) titleRaw = titleRaw.replace(/\b(every|each|other|and|on)\b/gi, ' ')
    titleRaw = titleRaw
      .replace(/^\s*(?:please\s+|kindly\s+)?(?:add|create|schedule|set\s*up|put|new|make)\b/i, '') // leading command
      .replace(/\b(?:to|on|in)\s+(?:the\s+|my\s+|our\s+)?calendar\b/gi, '') // "to (the) calendar" destination
    const title = titleCase(tidy(titleRaw)) || 'Event'
    const dayLabel = day?.label ?? target.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const whenLabel = [dayLabel, allDay ? 'All day' : time?.label ?? (day?.eveningHint ? '6:00 PM' : '')].filter(Boolean).join(' · ')
    const scheduleLabel = rec.rrule ? describeRrule(rec.rrule, target) : ''
    return { kind: 'event', title, startsAt: target.toISOString(), allDay, personName: person?.name ?? null, rrule: rec.rrule, recurrenceEndAt: null, scheduleLabel, whenLabel }
  }

  // PANTRY — an item on hand with an explicit pantry/fridge/freezer destination
  // ("add 2 cans of beans to the pantry"). Before the grocery fallback so it isn't
  // mis-routed to the shopping list; a bare "add milk" (no destination) stays grocery.
  const pantryIntent = detectPantry(text)
  if (pantryIntent) return pantryIntent

  // GROCERY — verbs, "to the list", units, or the bare-noun fallback.
  const groceryVerb = GROCERY_VERB.test(text)
  const groceryHint = groceryVerb || GROCERY_TO_LIST.test(text) || GROCERY_UNIT.test(text)
  const stripped = cut(text, person ? [person.span] : [])
    .replace(GROCERY_VERB, '')
    .replace(GROCERY_TO_LIST, '')
    .trim()
  const { quantity, name } = splitQuantity(stripped)
  const finalName = titleCase(name.replace(/^[\s,]+|[\s,]+$/g, ''))
  if (!finalName) return null
  // groceryHint is informational; we route here either way (sensible default).
  void groceryHint
  return { kind: 'grocery', name: finalName, quantity }
}

// Whether the on-device guess is strong enough to show before the model answers.
// Every kind requires an explicit signal to be chosen EXCEPT the bare-noun grocery
// fallback, which is a last resort — so we hold that one back while the LLM thinks.
export function looksConfident(intent: ParsedIntent | null, text: string): boolean {
  if (!intent) return false
  if (intent.kind !== 'grocery') return true
  // Generic verbs ("add", "get", "need") aren't grocery-specific — they fit
  // everything ("add a goal", "add soccer"). Only a real shopping cue counts:
  // a buy-verb, an explicit grocery/shopping list, or a unit amount.
  return /\b(buy|grab|pick(?:ing)?\s*up|purchase)\b/i.test(text) || GROCERY_TO_LIST.test(text) || GROCERY_UNIT.test(text)
}

// A short human label for the preview chip.
export function intentSummary(intent: ParsedIntent): { icon: string; kind: string; primary: string; detail: string } {
  switch (intent.kind) {
    case 'event':
      return { icon: '📅', kind: 'Event', primary: intent.title, detail: [intent.whenLabel, intent.scheduleLabel && `🔁 ${intent.scheduleLabel}`, intent.personName].filter(Boolean).join(' · ') }
    case 'grocery':
      return { icon: '🛒', kind: 'Grocery', primary: [intent.quantity, intent.name].filter(Boolean).join(' '), detail: 'Adds to the grocery list' }
    case 'task':
      return {
        icon: '✅',
        kind: 'Task',
        primary: intent.title,
        detail: [intent.personName ?? 'Up for grabs', intent.scheduleLabel, intent.stars ? `${intent.stars}★` : ''].filter(Boolean).join(' · '),
      }
    case 'meal':
      return { icon: '🍽️', kind: 'Meal', primary: intent.title, detail: `${intent.whenLabel} · meal plan` }
    case 'list':
      return {
        icon: '📝',
        kind: 'List',
        primary: [intent.quantity, intent.itemName].filter(Boolean).join(' '),
        detail: intent.listName ? `Adds to “${intent.listName}”` : 'Adds to a list',
      }
    case 'countdown':
      return { icon: '⏳', kind: 'Countdown', primary: intent.title, detail: intent.whenLabel }
    case 'person':
      return { icon: intent.avatarEmoji ?? '👤', kind: 'Family member', primary: intent.name, detail: memberTypeLabel(intent.memberType) }
    case 'goal':
      return {
        icon: '🎯',
        kind: 'Goal',
        primary: intent.title,
        detail: [
          goalTypeLabel(intent.goalType),
          intent.targetValue != null ? [intent.targetValue, intent.unit].filter(Boolean).join(' ') : '',
          intent.deadline ? `by ${intent.deadline}` : '',
        ].filter(Boolean).join(' · '),
      }
    case 'pantry':
      return {
        icon: '🥫',
        kind: 'Pantry',
        primary: [intent.amount, intent.unit, intent.name].filter(Boolean).join(' '),
        detail: [
          `Adds to ${intent.location}`,
          intent.expiresOn ? `expires ${intent.expiresOn}` : '',
        ].filter(Boolean).join(' · '),
      }
    case 'reward':
      return {
        icon: intent.emoji ?? '🎁',
        kind: 'Reward',
        primary: intent.title,
        detail: [
          'Adds to the reward shop',
          intent.cost != null ? `${intent.cost}★` : '',
          intent.requiresApproval ? 'needs approval' : '',
        ].filter(Boolean).join(' · '),
      }
    case 'unsupported':
      return { icon: '🤔', kind: 'Not supported yet', primary: intent.reason, detail: '' }
  }
}
