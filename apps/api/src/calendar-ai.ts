// Calendar AI cards (roadmap 6.x) — the "Heads up this week" digest and the
// per-event insight, both powered by the household's chosen model via the shared
// llm.ts layer (so they honor Settings → AI & capture and its keys, exactly like
// "Plan my week"). Every endpoint computes the same facts deterministically first,
// so when the provider is heuristic / offline / errors we still return a real,
// useful card instead of a blank one — the AI just rephrases the facts warmly.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from './db'
import { requireTenant } from './households'
import { completeJson } from './llm'
import { rangeEvents, getEventById, type EventRow } from './events'

type Api = ReturnType<typeof createAPI>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function householdTz(householdId: string): Promise<string> {
  const { rows } = await query<{ timezone: string }>(`select timezone from households where id = $1`, [householdId])
  return rows[0]?.timezone ?? 'UTC'
}

// Local calendar day (YYYY-MM-DD) and "HH:MM" for an instant in a timezone.
function partsInTz(at: Date, tz: string): { date: string; time: string; minutes: number; weekday: string } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(at)) m[p.type] = p.value
  const hour = m.hour === '24' ? '00' : m.hour
  return {
    date: `${m.year}-${m.month}-${m.day}`,
    time: `${hour}:${m.minute}`,
    minutes: +hour * 60 + +m.minute,
    weekday: m.weekday,
  }
}

function clock(time: string): string {
  const [h, mi] = time.split(':').map(Number)
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(mi).padStart(2, '0')} ${ap}`
}

function durationMin(e: EventRow): number {
  if (!e.ends_at) return 60
  const d = (new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000
  return d > 0 ? d : 60
}

// ── Heads up this week ───────────────────────────────────────────────────────
interface WeekFacts {
  total: number
  busiest: { weekday: string; count: number } | null
  conflicts: Array<{ a: string; b: string; weekday: string }>
  perPerson: Array<{ name: string; count: number }>
  byDay: Array<{ weekday: string; titles: string[] }>
}

function weekFacts(events: EventRow[], tz: string): WeekFacts {
  const days = new Map<string, { weekday: string; titles: string[]; timed: EventRow[] }>()
  const people = new Map<string, number>()
  for (const e of events) {
    const { date, weekday } = partsInTz(new Date(e.starts_at), tz)
    const bucket = days.get(date) ?? { weekday, titles: [], timed: [] }
    bucket.titles.push(e.title)
    if (!e.all_day) bucket.timed.push(e)
    days.set(date, bucket)
    if (e.person_name) people.set(e.person_name, (people.get(e.person_name) ?? 0) + 1)
  }
  // Busiest day.
  let busiest: WeekFacts['busiest'] = null
  for (const b of days.values()) {
    if (!busiest || b.titles.length > busiest.count) busiest = { weekday: b.weekday, count: b.titles.length }
  }
  // Same-day timed overlaps → conflicts.
  const conflicts: WeekFacts['conflicts'] = []
  for (const b of days.values()) {
    const t = [...b.timed].sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime())
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 1; j < t.length; j++) {
        const aS = new Date(t[i].starts_at).getTime()
        const aE = aS + durationMin(t[i]) * 60000
        const bS = new Date(t[j].starts_at).getTime()
        if (bS < aE) conflicts.push({ a: t[i].title, b: t[j].title, weekday: b.weekday })
      }
    }
  }
  return {
    total: events.length,
    busiest,
    conflicts,
    perPerson: [...people.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    byDay: [...days.values()].map((b) => ({ weekday: b.weekday, titles: b.titles.slice(0, 6) })),
  }
}

// Deterministic digest — the always-available fallback and the AI's grounding.
function headsUpFallback(f: WeekFacts): { headline: string; body: string } {
  if (f.total === 0) return { headline: 'Clear week', body: 'Nothing on the calendar yet — a good week to plan ahead.' }
  if (f.conflicts.length > 0) {
    const c = f.conflicts[0]
    return {
      headline: 'A clash to sort',
      body: `Heads up — “${c.a}” and “${c.b}” overlap on ${c.weekday}. ${f.busiest ? `${f.busiest.weekday} is the busiest day with ${f.busiest.count}.` : ''}`.trim(),
    }
  }
  if (f.busiest && f.busiest.count >= 3) {
    return { headline: 'One busy day', body: `${f.busiest.weekday} is stacked with ${f.busiest.count} things — the rest of the week is lighter. Nothing’s double-booked.` }
  }
  return { headline: 'A calmer week', body: `${f.total} thing${f.total === 1 ? '' : 's'} on the calendar and nothing’s double-booked. Tap a day to plan ahead.` }
}

const HEADS_UP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: '2–4 word headline' },
    body: { type: 'string', description: 'Warm, practical 1–2 sentences' },
  },
  required: ['headline', 'body'],
}

export async function weekHeadsUp(householdId: string, from: string, to: string): Promise<{ headline: string; body: string; via: string }> {
  const tz = await householdTz(householdId)
  const events = await rangeEvents(householdId, from, to)
  const facts = weekFacts(events, tz)
  const fallback = headsUpFallback(facts)
  try {
    const system = [
      "You write the one short 'Heads up this week' card on a family hub's calendar.",
      'Given a factual summary of the week, return a 2–4 word headline and a warm, practical 1–2 sentence body.',
      'Call out the busiest day or any scheduling clash when present; otherwise reassure. Be specific, never generic. No emojis. JSON only.',
    ].join('\n')
    const { data, via } = await completeJson(householdId, {
      system,
      user: JSON.stringify(facts),
      schema: HEADS_UP_SCHEMA,
      schemaName: 'heads_up',
      maxTokens: 300,
    })
    const d = data as { headline?: unknown; body?: unknown }
    const headline = String(d.headline ?? '').trim() || fallback.headline
    const body = String(d.body ?? '').trim() || fallback.body
    return { headline, body, via }
  } catch {
    return { ...fallback, via: 'heuristic' }
  }
}

// ── Per-event insight ────────────────────────────────────────────────────────
function eventInsightFallback(e: EventRow, tz: string): { headline: string; body: string; leaveBy: string | null; reminder: string } {
  const hasLoc = !!e.location?.trim()
  if (hasLoc && !e.all_day) {
    return {
      headline: 'Plan your trip',
      body: `“${e.title}” is at ${e.location}. Check the route before you head out so you’re not rushing.`,
      leaveBy: null,
      reminder: `Set an alarm ~30 minutes before you need to leave for ${e.title}.`,
    }
  }
  if (hasLoc) {
    return { headline: 'Know before you go', body: `“${e.title}” is at ${e.location}. Worth confirming the details the day before.`, leaveBy: null, reminder: `Remind yourself the night before about ${e.title}.` }
  }
  return { headline: 'Stay on track', body: `A nudge before “${e.title}” starts will help you stay on top of the day.`, leaveBy: null, reminder: `Set a reminder shortly before ${e.title} begins.` }
}

const INSIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: '2–4 word headline' },
    body: { type: 'string', description: 'Concrete prep advice, 1–2 sentences' },
    leaveBy: { type: ['string', 'null'], description: 'Clock time like "3:30 PM" to leave by — only when there is a location and a start time and travel matters; else null' },
    reminder: { type: 'string', description: 'One-sentence reminder nudge the user could set' },
  },
  required: ['headline', 'body', 'reminder'],
}

export async function eventInsight(
  householdId: string,
  id: string
): Promise<{ headline: string; body: string; leaveBy: string | null; reminder: string; via: string } | null> {
  const tz = await householdTz(householdId)
  const event = await getEventById(householdId, id)
  if (!event) return null
  const fallback = eventInsightFallback(event, tz)
  try {
    const p = partsInTz(new Date(event.starts_at), tz)
    const ctx = {
      now: new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      event: {
        title: event.title,
        weekday: p.weekday,
        startTime: event.all_day ? null : clock(p.time),
        allDay: event.all_day,
        durationMinutes: event.all_day ? null : durationMin(event),
        location: event.location ?? null,
        recurring: !!event.rrule,
        isPlannedMeal: event.origin === 'meal_plan',
        with: (event.participants ?? []).map((x) => x.name).filter(Boolean),
        notes: event.description ?? null,
      },
    }
    const system = [
      "You write a short, practical insight card for ONE event on a family hub's calendar.",
      'Return a 2–4 word headline, a 1–2 sentence body with concrete prep advice (what to bring or do beforehand),',
      'an optional leaveBy clock time (ONLY when the event has a location and a start time and travel genuinely matters — otherwise null),',
      'and a one-sentence reminder nudge the user could set. Ground everything in the event details. No emojis. JSON only.',
    ].join('\n')
    const { data, via } = await completeJson(householdId, {
      system,
      user: JSON.stringify(ctx),
      schema: INSIGHT_SCHEMA,
      schemaName: 'event_insight',
      maxTokens: 300,
    })
    const d = data as { headline?: unknown; body?: unknown; leaveBy?: unknown; reminder?: unknown }
    return {
      headline: String(d.headline ?? '').trim() || fallback.headline,
      body: String(d.body ?? '').trim() || fallback.body,
      leaveBy: typeof d.leaveBy === 'string' && d.leaveBy.trim() ? d.leaveBy.trim() : null,
      reminder: String(d.reminder ?? '').trim() || fallback.reminder,
      via,
    }
  } catch {
    return { ...fallback, via: 'heuristic' }
  }
}

export function registerCalendarAiRoutes(api: Api): void {
  // "Heads up this week" digest. Defaults to today..+6 in the household tz.
  api.get('/api/calendar/heads-up', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const tz = await householdTz(tenant.householdId)
    const todayLocal = partsInTz(new Date(), tz).date
    let from = typeof req.query?.from === 'string' && DATE_RE.test(req.query.from) ? req.query.from : todayLocal
    let to = typeof req.query?.to === 'string' && DATE_RE.test(req.query.to) ? req.query.to : ''
    if (!to) {
      const d = new Date(`${from}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + 6)
      to = d.toISOString().slice(0, 10)
    }
    if (from > to) [from, to] = [to, from]
    return weekHeadsUp(tenant.householdId, from, to)
  })

  // Per-event insight for the detail screen's AI card + "Remind me".
  api.get('/api/events/:id/insight', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    const insight = await eventInsight(tenant.householdId, id)
    if (!insight) return res.status(404).json({ error: 'NotFound', message: 'event not found' })
    return insight
  })
}
