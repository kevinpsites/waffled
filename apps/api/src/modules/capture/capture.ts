// Capture-bar intent parsing (roadmap 6.6) — pluggable LLM providers behind one
// interface. The *active provider + model* is chosen per household and stored in
// households.settings.ai (non-secret, editable in Settings). The *credentials*
// (API keys / local host) live only in the environment (config.ai) and are never
// returned to clients. If no provider is configured, errors out, or the model
// times out, the route signals `fallback` and the kiosk uses its on-device
// heuristic parser — so the bar always works, even offline.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireTenant, requireAdmin } from '../households/households'
import config from '../../platform/config'
import {
  completeJson,
  getAiConfig,
  setAiConfig,
  availability,
  defaultModel,
  PROVIDERS,
  type Provider,
} from '../../platform/llm'

type Api = ReturnType<typeof createAPI>

// What the model is asked to emit. Mirrors the kiosk's ParsedIntent so the client
// treats a server parse and a local heuristic parse identically.
export interface CaptureIntent {
  kind: 'event' | 'task' | 'grocery' | 'meal' | 'list' | 'unsupported'
  title?: string
  name?: string | null
  quantity?: string | null
  personName?: string | null
  startsAt?: string | null
  allDay?: boolean | null
  rrule?: string | null
  stars?: number | null
  date?: string | null
  mealType?: string | null
  // list intent: add itemName to the named (non-grocery) list
  listName?: string | null
  itemName?: string | null
  // unsupported intent: a short, friendly reason quick-add can't do it
  reason?: string
  whenLabel?: string
  scheduleLabel?: string
}

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack'])

interface CaptureContext {
  now: string
  timezone: string
  people: string[]
  lists?: string[]
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const BYDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

// ── Prompt + JSON schema shared by every provider ────────────────────────────
const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['event', 'task', 'grocery', 'meal', 'list', 'unsupported'] },
    title: { type: ['string', 'null'], description: 'Clean title for event/task; the dish for a meal' },
    name: { type: ['string', 'null'], description: 'Grocery item name' },
    quantity: { type: ['string', 'null'], description: 'Grocery/list amount, e.g. "2 lbs"' },
    listName: { type: ['string', 'null'], description: 'For kind=list: the target custom list (match one of the household lists when possible)' },
    itemName: { type: ['string', 'null'], description: 'For kind=list: the item to add to that list' },
    reason: { type: ['string', 'null'], description: 'For kind=unsupported: a short friendly reason quick-add cannot do this yet' },
    personName: { type: ['string', 'null'], description: 'Exactly one of the family names, or null' },
    startsAt: { type: ['string', 'null'], description: 'Event start, local date-time with no zone' },
    allDay: { type: ['boolean', 'null'] },
    rrule: { type: ['string', 'null'], description: 'Recurring task, e.g. FREQ=WEEKLY;BYDAY=MO,WE' },
    stars: { type: ['integer', 'null'] },
    date: { type: ['string', 'null'], description: 'Meal date as YYYY-MM-DD: the resolved day the user said (today/tomorrow/Friday/next Thursday); only today if none was said' },
    mealType: { type: ['string', 'null'], enum: ['breakfast', 'lunch', 'dinner', 'snack', null], description: 'Meal slot (default dinner)' },
  },
  required: ['kind'],
}

function systemPrompt(ctx: CaptureContext): string {
  const fam = ctx.people.length ? ctx.people.join(', ') : '(none known yet)'
  return [
    "You convert a family member's quick note into ONE structured action for a family hub.",
    'Return ONLY a JSON object matching the schema — no prose, no markdown.',
    `Right now it is ${ctx.now} (timezone ${ctx.timezone}).`,
    `Family members: ${fam}.`,
    `Custom lists: ${ctx.lists && ctx.lists.length ? ctx.lists.join(', ') : '(none yet)'}.`,
    '',
    'Kinds: "event" = happens at a date/time; "task" = a chore someone does, maybe recurring; "grocery" = an item to buy (the grocery/shopping list); "meal" = a dish for the weekly meal plan; "list" = add an item to a named custom list (packing list, Costco, Target run, etc. — NOT groceries); "unsupported" = anything else.',
    'Always follow these rules:',
    '- ALWAYS extract a concise "title" (for grocery use "name") — strip command words like "please add", "make a chore to", "to X\'s list".',
    '- If a quoted phrase is present, use it verbatim as the title.',
    '- personName MUST be exactly one of the family members if the note refers to one (case-insensitive, ignore possessives like "Kelly\'s" → "Kelly"); otherwise null.',
    '- event: compute startsAt as a LOCAL date-time with NO timezone suffix (e.g. 2026-06-16T16:00:00) — the server applies the household timezone. Resolve relative dates (today/tomorrow/"Tue") against the current date above; allDay=true only when no clock time is given.',
    '- task: recurring → rrule with two-letter weekday codes (FREQ=WEEKLY;BYDAY=MO,WE,SA) or FREQ=DAILY; one-off → rrule null.',
    '- grocery: ONLY the grocery/shopping list or bare food/household-shopping items. "quantity" is just the amount (e.g. "2 lbs"), or null. Never prefix it with a label.',
    '- list: "add X to (the) <list>" / "put X on my <list>" where <list> is a NAMED non-grocery list → kind "list" with itemName=X and listName=the list. Match listName to one of the Custom lists above when it clearly refers to one (e.g. "the lake packing trip" → "Lake trip packing"); otherwise keep the user\'s name. Optional "quantity".',
    '- "eating out" / "order in" / "takeout" / "delivery" (no clock time) → kind "meal" with title "Eating out".',
    '- meal: "meal plan", "on the menu", or "<dish> for dinner/lunch/breakfast" → kind "meal". Put the dish in "title" and set "mealType" (default "dinner"). For "date", RESOLVE any relative day (today/tomorrow/"Friday"/"next Thursday") against the current date above into YYYY-MM-DD — exactly like events do — and ONLY default to today when no day is mentioned. A specific clock time means it is an EVENT, not a meal.',
    '- unsupported: if the note is a GOAL ("set a goal to…", "I want to read 5 books"), a reminder/notification, or anything that is not an event, task/chore, grocery item, meal, or list item, return kind "unsupported" with a short friendly "reason" (e.g. "Quick-add doesn\'t create goals yet — add it from the Goals screen."). Do NOT force it into another kind.',
    '- stars = the integer reward if mentioned, else null.',
    '',
    'Examples below ASSUME today is Thursday June 11 2026. Always recompute dates from the ACTUAL current date stated above, not from this example date:',
    '"Soccer Tue 4pm for Wally" -> {"kind":"event","title":"Soccer","personName":"Wally","startsAt":"2026-06-16T16:00:00","allDay":false}',
    '"dentist tomorrow" -> {"kind":"event","title":"Dentist","personName":null,"startsAt":"2026-06-12T00:00:00","allDay":true}',
    '"Please add laundry for Monday and Saturday to Kelly\'s chore list" -> {"kind":"task","title":"Laundry","personName":"Kelly","rrule":"FREQ=WEEKLY;BYDAY=MO,SA","stars":null}',
    '"\\"Take Out the Trash\\" for Lottie on Tuesday and Thursday" -> {"kind":"task","title":"Take Out the Trash","personName":"Lottie","rrule":"FREQ=WEEKLY;BYDAY=TU,TH"}',
    '"grab 2 lbs of chicken thighs" -> {"kind":"grocery","name":"chicken thighs","quantity":"2 lbs"}',
    '"add towels to the lake packing trip" -> {"kind":"list","itemName":"Towels","listName":"Lake trip packing"}',
    '"put sunscreen and goggles on the beach list" -> {"kind":"list","itemName":"Sunscreen and goggles","listName":"Beach"}',
    '"lets put shawarma on the meal plan" -> {"kind":"meal","title":"Shawarma","mealType":"dinner"}',
    '"tacos for lunch on Friday" -> {"kind":"meal","title":"Tacos","mealType":"lunch","date":"2026-06-12"}',
    '"I want fish for dinner next Thursday" -> {"kind":"meal","title":"Fish","mealType":"dinner","date":"2026-06-18"}',
    '"we\'re eating out Friday" -> {"kind":"meal","title":"Eating out","mealType":"dinner","date":"2026-06-12"}',
    '"set a goal to read 20 books this year" -> {"kind":"unsupported","reason":"Quick-add doesn\'t create goals yet — add it from the Goals screen."}',
  ].join('\n')
}

// ── Normalize a raw model object into a finished CaptureIntent ────────────────
export function finalizeIntent(raw: unknown, ctx: CaptureContext): CaptureIntent {
  const r = (raw ?? {}) as Record<string, unknown>
  const kindRaw = String(r.kind ?? '').toLowerCase()
  const kind: CaptureIntent['kind'] = (['event', 'grocery', 'meal', 'list', 'unsupported'] as const).find((k) => k === kindRaw) ?? 'task'

  // Only accept a person that's actually in the family (case-insensitive).
  const pn = r.personName == null ? null : String(r.personName)
  const personName = pn ? ctx.people.find((p) => p.toLowerCase() === pn.toLowerCase()) ?? null : null

  if (kind === 'unsupported') {
    return { kind, reason: String(r.reason ?? '').trim() || 'That isn’t something quick-add can do yet.' }
  }
  if (kind === 'list') {
    const itemName = String(r.itemName ?? r.name ?? r.title ?? '').trim()
    if (!itemName) throw new Error('list: no item')
    // Snap a loosely-named list to a real household list when it clearly matches.
    const raw0 = r.listName == null ? null : String(r.listName).trim()
    const listName = raw0 ? matchList(raw0, ctx.lists ?? []) : null
    return { kind, itemName, listName, quantity: r.quantity ? String(r.quantity) : null }
  }
  if (kind === 'grocery') {
    const name = String(r.name ?? r.title ?? '').trim()
    if (!name) throw new Error('grocery: no item')
    return { kind, name, quantity: r.quantity ? String(r.quantity) : null }
  }
  if (kind === 'meal') {
    const title = String(r.title ?? r.name ?? '').trim()
    if (!title) throw new Error('meal: no dish')
    const mt = String(r.mealType ?? 'dinner').toLowerCase()
    const mealType = MEAL_TYPES.has(mt) ? mt : 'dinner'
    const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : todayInTz(ctx.timezone)
    return { kind, title, date, mealType, whenLabel: `${mealDayLabel(date, ctx.timezone)} · ${cap(mealType)}` }
  }
  if (kind === 'event') {
    const raw0 = r.startsAt ? String(r.startsAt) : null
    if (!raw0 || Number.isNaN(Date.parse(zonedToUtc(raw0, ctx.timezone)))) throw new Error('event: bad startsAt')
    const startsAt = zonedToUtc(raw0, ctx.timezone)
    const allDay = r.allDay == null ? true : !!r.allDay
    return {
      kind,
      title: String(r.title ?? 'Event').trim() || 'Event',
      startsAt,
      allDay,
      personName,
      whenLabel: whenLabel(startsAt, allDay, ctx.timezone),
    }
  }
  // task / chore
  const rrule = r.rrule ? String(r.rrule) : null
  return {
    kind: 'task',
    title: String(r.title ?? 'Task').trim() || 'Task',
    personName,
    stars: r.stars == null ? null : Number(r.stars) || null,
    rrule,
    scheduleLabel: scheduleLabel(rrule),
  }
}

// Snap a loosely-named list ("the lake packing trip") to a real household list
// ("Lake trip packing") by token overlap; falls back to the raw name (so the
// client can create it) when nothing matches well.
const normList = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an|my|our|trip|list|to|for)\b/g, ' ').replace(/\s+/g, ' ').trim()

// Best known-list match for free text, or null. Scored by how many of the list's
// tokens appear in the text — so "the lake packing trip" snaps to "Lake trip packing".
function matchListStrict(raw: string, lists: string[]): string | null {
  const ttoks = new Set(normList(raw).split(' ').filter(Boolean))
  if (!ttoks.size) return null
  let best: { name: string; score: number } | null = null
  for (const l of lists) {
    const ltoks = normList(l).split(' ').filter(Boolean)
    if (!ltoks.length) continue
    if (normList(l) === [...ttoks].join(' ')) return l
    const inter = ltoks.filter((t) => ttoks.has(t)).length
    const score = inter / ltoks.length
    if (score >= 0.6 && (!best || score > best.score)) best = { name: l, score }
  }
  return best?.name ?? null
}
// Match-or-keep: snaps to a real list when possible, else keeps the raw name so
// the client can create it.
function matchList(raw: string, lists: string[]): string {
  return matchListStrict(raw, lists) ?? raw
}

// The tz's offset (ms) from UTC at a given instant, via Intl — no tz library.
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(at)) m[p.type] = p.value
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +(m.hour === '24' ? '0' : m.hour), +m.minute, +m.second)
  return asUTC - at.getTime()
}

// Normalize a model datetime to a UTC ISO string. A naive local value (no zone
// suffix) is interpreted in the household timezone; an explicit offset/Z is kept.
function zonedToUtc(value: string, tz: string): string {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value.trim())
  if (hasZone) return new Date(value).toISOString()
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim())
  if (!m) return new Date(value).toISOString() // let Date try; finalize validates
  const [, y, mo, d, h, mi, s] = m
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))
  const off = tzOffsetMs(new Date(guess), tz)
  return new Date(guess - off).toISOString()
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

// Today's date (YYYY-MM-DD) in a timezone — the default meal date.
function todayInTz(tz: string): string {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

const WD: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
}
const MO: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
}

// Deterministically resolve a calendar day from free text (today/tomorrow,
// a weekday optionally with "next", "in N days", a month+day, or m/d) → the
// model is unreliable at date math, so we do it ourselves. null = no day stated.
export function resolveDayFromText(text: string, tz: string): string | null {
  const today = todayInTz(tz)
  const base = new Date(`${today}T00:00:00Z`)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const add = (n: number) => {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + n)
    return iso(d)
  }
  const t = text.toLowerCase()
  if (/\b(today|tonight|this evening)\b/.test(t)) return today
  if (/\btomorrow\b/.test(t)) return add(1)
  if (/\byesterday\b/.test(t)) return add(-1)

  const wd = /\b(next\s+)?(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)\b/.exec(t)
  if (wd) {
    let delta = (WD[wd[2]] - base.getUTCDay() + 7) % 7
    if (wd[1]) delta += 7 // "next <weekday>" → a full week out
    return add(delta)
  }
  const inDays = /\bin\s+(\d{1,2})\s+days?\b/.exec(t)
  if (inDays) return add(parseInt(inDays[1], 10))

  const md = /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})\b/.exec(t)
  if (md) {
    const mo = MO[md[1]]
    const day = parseInt(md[2], 10)
    let year = base.getUTCFullYear()
    if (mo < base.getUTCMonth() || (mo === base.getUTCMonth() && day < base.getUTCDate())) year += 1
    return iso(new Date(Date.UTC(year, mo, day)))
  }
  const num = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t)
  if (num) {
    const mo = parseInt(num[1], 10) - 1
    const day = parseInt(num[2], 10)
    if (mo >= 0 && mo <= 11 && day >= 1 && day <= 31) {
      let year = base.getUTCFullYear()
      if (mo < base.getUTCMonth() || (mo === base.getUTCMonth() && day < base.getUTCDate())) year += 1
      return iso(new Date(Date.UTC(year, mo, day)))
    }
  }
  return null
}

// "Today" / "Tomorrow" / a weekday for a meal date, relative to today in tz.
function mealDayLabel(date: string, tz: string): string {
  const today = todayInTz(tz)
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function whenLabel(iso: string, allDay: boolean, tz: string): string {
  const d = new Date(iso)
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })
  if (allDay) return `${day} · All day`
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${day} · ${time}`
}

function scheduleLabel(rrule: string | null): string {
  if (!rrule) return ''
  if (/FREQ=DAILY/i.test(rrule)) return 'Every day'
  const m = /BYDAY=([A-Z,]+)/i.exec(rrule)
  if (!m) return ''
  return m[1]
    .split(',')
    .map((c) => DAY_SHORT[BYDAY_INDEX[c.toUpperCase()]] ?? '')
    .filter(Boolean)
    .join(' & ')
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function parseWithProvider(householdId: string, text: string): Promise<{ intent: CaptureIntent; via: Provider }> {
  const { provider } = await getAiConfig(householdId)
  if (provider === 'heuristic') throw new Error('heuristic provider — defer to client')

  const { rows } = await query<{ timezone: string }>(`select timezone from households where id = $1`, [householdId])
  const { rows: people } = await query<{ name: string }>(
    `select name from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`,
    [householdId]
  )
  // Named custom lists (not the auto grocery list) so the model can route to them.
  const { rows: listRows } = await query<{ name: string }>(
    `select name from lists where household_id = $1 and deleted_at is null and list_type <> 'grocery' order by sort_order, created_at`,
    [householdId]
  )
  const tz = rows[0]?.timezone ?? 'UTC'
  // Human-readable local now (with weekday) so the model can resolve "Tue 4pm".
  const nowLocal = new Date().toLocaleString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  const ctx: CaptureContext = { now: nowLocal, timezone: tz, people: people.map((p) => p.name), lists: listRows.map((l) => l.name) }

  // One shared call across providers (honors the household's toggle + keys).
  const { data: raw, via } = await completeJson(householdId, {
    system: systemPrompt(ctx),
    user: text,
    schema: INTENT_SCHEMA,
    schemaName: 'record_intent',
    maxTokens: 512,
  })

  const intent = finalizeIntent(raw, ctx)
  // Small local models are unreliable at date math: if the meal text clearly
  // names a day, resolve it deterministically and override the model's guess.
  if (intent.kind === 'meal') {
    const resolved = resolveDayFromText(text, ctx.timezone)
    if (resolved && resolved !== intent.date) {
      intent.date = resolved
      intent.whenLabel = `${mealDayLabel(resolved, ctx.timezone)} · ${cap(intent.mealType ?? 'dinner')}`
    }
  }
  // Likewise small models often drop the list name — recover it from the raw text
  // against the household's lists when the model left it unmatched.
  if (intent.kind === 'list' && !(intent.listName && (ctx.lists ?? []).includes(intent.listName))) {
    const fromText = matchListStrict(text, ctx.lists ?? [])
    if (fromText) intent.listName = fromText
  }
  return { intent, via }
}

// Preload a local model so the first real parse isn't a cold start. Best-effort,
// only meaningful for Ollama (hosted providers are always "warm").
export async function warmProvider(householdId: string): Promise<void> {
  const { provider, model } = await getAiConfig(householdId)
  if (provider !== 'ollama' || !availability().ollama) return
  const host = (config.ai.ollama.host ?? '').replace(/\/$/, '')
  const m = model ?? config.ai.ollama.defaultModel
  await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: m, prompt: '', keep_alive: '30m' }),
  }).catch(() => {})
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function registerCaptureRoutes(api: Api): void {
  // Warm the model (fire-and-forget) — the kiosk calls this when the capture bar
  // gains focus so the model is loaded by the time you press ↵.
  api.post('/api/capture/warm', async (req: Request) => {
    const tenant = await requireTenant(req)
    void warmProvider(tenant.householdId)
    return { warming: true }
  })

  // Parse free text → intent. On any failure, tell the client to fall back to
  // its on-device heuristic (200 with fallback:true, not an error).
  api.post('/api/capture', async (req: Request) => {
    const tenant = await requireTenant(req)
    const text = String((req.body as { text?: unknown })?.text ?? '').trim()
    if (!text) return { intent: null, via: 'heuristic', fallback: true }
    try {
      const { intent, via } = await parseWithProvider(tenant.householdId, text)
      return { intent, via, fallback: false }
    } catch (err) {
      return { intent: null, via: 'heuristic', fallback: true, error: (err as Error).message }
    }
  })

  // Current selection + which providers the environment makes available + the
  // default model for each. Never returns secrets.
  api.get('/api/capture/config', async (req: Request) => {
    const tenant = await requireTenant(req)
    const { provider, model } = await getAiConfig(tenant.householdId)
    return {
      provider,
      model,
      available: availability(),
      defaultModels: {
        anthropic: config.ai.anthropic.defaultModel,
        openai: config.ai.openai.defaultModel,
        ollama: config.ai.ollama.defaultModel,
      },
    }
  })

  // Flip the active provider/model (admins only).
  api.put('/api/capture/config', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as { provider?: string; model?: string | null }
    const provider = body.provider as Provider
    if (!(PROVIDERS as string[]).includes(provider)) {
      return res.status(400).json({ error: 'BadRequest', message: `provider must be one of ${PROVIDERS.join(', ')}` })
    }
    if (provider !== 'heuristic' && !availability()[provider]) {
      return res.status(400).json({ error: 'BadRequest', message: `provider ${provider} has no credentials configured on the server` })
    }
    const model = body.model != null ? String(body.model).trim() || null : defaultModel(provider)
    await setAiConfig(tenant.householdId, provider, model)
    return { provider, model }
  })
}
