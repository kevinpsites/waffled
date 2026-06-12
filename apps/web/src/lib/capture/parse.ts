// Local heuristic parser for the "Add anything…" capture bar (roadmap 6.6).
// Zero external calls — turns free text into a structured intent the kiosk can
// commit to the right domain (event / grocery / task / meal). A Claude-backed
// upgrade can swap in later behind the same ParsedIntent shape.
//
// Routing priority: a date/time → event; otherwise a grocery signal → grocery;
// otherwise a task signal → task; bare nouns fall back to grocery (the most
// common quick capture). `now` is injected so the logic is deterministic in tests.

export type ParsedIntent =
  | { kind: 'event'; title: string; startsAt: string; allDay: boolean; personName: string | null; whenLabel: string }
  | { kind: 'grocery'; name: string; quantity: string | null }
  | { kind: 'task'; title: string; personName: string | null; stars: number | null; rrule: string | null; scheduleLabel: string }
  | { kind: 'meal'; title: string; date: string | null; mealType: string; whenLabel: string }

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

export function parseCapture(raw: string, persons: string[] = [], now: Date = new Date()): ParsedIntent | null {
  const text = raw.trim()
  if (!text) return null

  const person = findPerson(text, persons)

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

  const day = findDay(text, now)
  const time = findTime(text)

  // EVENT — anything with a concrete day or time.
  if (day || time) {
    const target = day ? new Date(day.y, day.mo, day.d) : startOfDay(now)
    let allDay = true
    if (time) {
      target.setHours(time.h, time.m, 0, 0)
      allDay = false
    } else if (day?.eveningHint) {
      target.setHours(18, 0, 0, 0)
      allDay = false
    }
    const spans = [day?.span, time?.span, person?.span].filter(Boolean) as Span[]
    const title = titleCase(tidy(cut(text, spans))) || 'Event'
    const whenLabel = [day?.label ?? 'Today', allDay ? 'All day' : time?.label ?? (day?.eveningHint ? '6:00 PM' : '')]
      .filter(Boolean)
      .join(' · ')
    return { kind: 'event', title, startsAt: target.toISOString(), allDay, personName: person?.name ?? null, whenLabel }
  }

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

// A short human label for the preview chip.
export function intentSummary(intent: ParsedIntent): { icon: string; kind: string; primary: string; detail: string } {
  switch (intent.kind) {
    case 'event':
      return { icon: '📅', kind: 'Event', primary: intent.title, detail: [intent.whenLabel, intent.personName].filter(Boolean).join(' · ') }
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
  }
}
