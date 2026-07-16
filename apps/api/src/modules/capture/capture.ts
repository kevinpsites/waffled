// Capture-bar intent parsing (roadmap 6.6) — pluggable LLM providers behind one
// interface. The *active provider + model* is chosen per household and stored in
// households.settings.ai (non-secret, editable in Settings). The *credentials*
// (API keys / local host) live only in the environment (config.ai) and are never
// returned to clients. If no provider is configured, errors out, or the model
// times out, the route signals `fallback` and the kiosk uses its on-device
// heuristic parser — so the bar always works, even offline.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { tenantRoute, adminRoute } from '../../platform/route-guards'
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
  kind: 'event' | 'task' | 'grocery' | 'meal' | 'list' | 'countdown' | 'person' | 'goal' | 'pantry' | 'reward' | 'unsupported'
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
  // countdown intent: a future day to count down to
  emoji?: string | null
  // person intent: a new household member
  memberType?: string | null
  avatarEmoji?: string | null
  birthday?: string | null
  isAdmin?: boolean | null
  // goal intent: a personal/shared goal (count/total/habit/checklist)
  goalType?: string | null
  trackingMode?: string | null
  participantMode?: string | null
  targetBasis?: string | null
  targetValue?: number | null
  unit?: string | null
  deadline?: string | null
  audience?: string | null
  // goal intent: which household members the goal is for (the LLM does not pick
  // people, so this is always [] server-side; the web goal type requires string[]).
  participantIds?: string[]
  // pantry intent: an item already on hand (module `pantry`, default off)
  amount?: string | null
  location?: string | null
  expiresOn?: string | null
  lowAt?: number | null
  // reward intent: a reward-shop item (gated on rewards + reward.manage)
  cost?: number | null
  currency?: string | null
  category?: string | null
  requiresApproval?: boolean | null
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
    kind: { type: 'string', enum: ['event', 'task', 'grocery', 'meal', 'list', 'countdown', 'person', 'goal', 'pantry', 'reward', 'unsupported'] },
    title: { type: ['string', 'null'], description: 'Clean title for event/task; the dish for a meal; the goal for a goal; the reward name for a reward' },
    name: { type: ['string', 'null'], description: 'Grocery item name, (kind=person) the new family member\'s name, or (kind=pantry) the on-hand item\'s name' },
    quantity: { type: ['string', 'null'], description: 'Grocery/list amount, e.g. "2 lbs"' },
    listName: { type: ['string', 'null'], description: 'For kind=list: the target custom list (match one of the household lists when possible)' },
    itemName: { type: ['string', 'null'], description: 'For kind=list: the item to add to that list' },
    reason: { type: ['string', 'null'], description: 'For kind=unsupported: a short friendly reason quick-add cannot do this yet' },
    personName: { type: ['string', 'null'], description: 'Exactly one of the family names, or null' },
    startsAt: { type: ['string', 'null'], description: 'Event start, local date-time with no zone' },
    allDay: { type: ['boolean', 'null'] },
    rrule: { type: ['string', 'null'], description: 'Recurrence for an EVENT or task (RFC5545 RRULE), e.g. FREQ=WEEKLY;BYDAY=TU or FREQ=DAILY or FREQ=MONTHLY' },
    stars: { type: ['integer', 'null'] },
    date: { type: ['string', 'null'], description: 'Date as YYYY-MM-DD for a meal or countdown: the resolved day the user said (today/tomorrow/Friday/next Thursday/in 12 days); only today if none was said' },
    mealType: { type: ['string', 'null'], enum: ['breakfast', 'lunch', 'dinner', 'snack', null], description: 'Meal slot (default dinner)' },
    emoji: { type: ['string', 'null'], description: 'For kind=countdown or kind=reward: a single fitting emoji, or null' },
    memberType: { type: ['string', 'null'], enum: ['adult', 'teen', 'kid', null], description: 'For kind=person: adult | teen | kid (default adult)' },
    avatarEmoji: { type: ['string', 'null'], description: 'For kind=person: a single fitting face emoji, or null' },
    birthday: { type: ['string', 'null'], description: 'For kind=person: their birthday as YYYY-MM-DD if given (NEVER inferred from an age), else null' },
    isAdmin: { type: ['boolean', 'null'], description: 'For kind=person: true only if they are clearly a parent/guardian' },
    goalType: { type: ['string', 'null'], enum: ['count', 'total', 'habit', 'checklist', null], description: 'For kind=goal: count (a countable target), total (an accumulating amount), habit (a recurring habit with no number), or checklist (a list of steps). Default habit.' },
    trackingMode: { type: ['string', 'null'], enum: ['shared_total', 'each_tracks', null], description: 'For kind=goal: shared_total (one shared progress bar) or each_tracks (everyone tracks their own). Default shared_total.' },
    participantMode: { type: ['string', 'null'], enum: ['count_once', 'split', null], description: 'For kind=goal: how a shared group entry counts — count_once (default) or split.' },
    targetBasis: { type: ['string', 'null'], enum: ['family', 'per_person', null], description: 'For kind=goal: family (one flat target, default) or per_person (ring = target × members).' },
    targetValue: { type: ['number', 'null'], description: 'For kind=goal (count/total): the numeric target, e.g. 20 for "read 20 books". Null when there is no number.' },
    unit: { type: ['string', 'null'], description: 'For kind=goal (count/total): the unit of the target, e.g. "books", "miles", "dollars"; for kind=pantry: the amount\'s unit, e.g. "cans", "lbs". Else null.' },
    deadline: { type: ['string', 'null'], description: 'For kind=goal: a YYYY-MM-DD deadline if a date is given ("this year" → the Dec 31 of the current year), else null' },
    audience: { type: ['string', 'null'], enum: ['me', 'everyone', null], description: 'For kind=goal: who the goal is for, inferred from the phrasing — "everyone" for a family/shared/together goal ("set a family goal", "our goal", "we want to"), "me" for a personal one ("personal goal", "my own", "I want to"), else null.' },
    amount: { type: ['string', 'null'], description: 'For kind=pantry: how much is on hand, e.g. "2" (pair with unit) or "2 lbs". Else null.' },
    location: { type: ['string', 'null'], description: 'For kind=pantry: where it is stored (e.g. Pantry, Fridge, Freezer). Default Pantry.' },
    expiresOn: { type: ['string', 'null'], description: 'For kind=pantry: an expiry date YYYY-MM-DD if one is given, else null.' },
    lowAt: { type: ['number', 'null'], description: 'For kind=pantry: the "running low" threshold number if mentioned, else null.' },
    cost: { type: ['integer', 'null'], description: 'For kind=reward: the star/point price as a non-negative whole number (e.g. 50 for "for 50 stars"), else null.' },
    currency: { type: ['string', 'null'], description: 'For kind=reward: the star/point currency name if a non-default one is named, else null.' },
    category: { type: ['string', 'null'], description: 'For kind=reward: a shop category (e.g. treats, screen time) if one is clear, else null.' },
    requiresApproval: { type: ['boolean', 'null'], description: 'For kind=reward: true/false ONLY if the note says whether a parent must approve; else null to inherit the household default.' },
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
    'Kinds: "event" = happens at a date/time; "task" = a chore someone does, maybe recurring; "grocery" = an item to buy (the grocery/shopping list); "pantry" = an item you ALREADY HAVE on hand, stored in the pantry/fridge/freezer (NOT the shopping list); "meal" = a dish for the weekly meal plan; "list" = add an item to a named custom list (packing list, Costco, Target run, etc. — NOT groceries); "countdown" = a future day to count down to (no clock time); "person" = add a new family/household member; "goal" = a personal or shared goal to work toward; "reward" = a reward-shop item kids can spend their stars/points on; "unsupported" = anything else.',
    'Always follow these rules:',
    '- ALWAYS extract a concise "title" (for grocery use "name") — strip command words like "please add", "make a chore to", "to X\'s list".',
    '- If a quoted phrase is present, use it verbatim as the title.',
    '- personName MUST be exactly one of the family members if the note refers to one (case-insensitive, ignore possessives like "Kelly\'s" → "Kelly"); otherwise null.',
    '- event: compute startsAt as a LOCAL date-time with NO timezone suffix (e.g. 2026-06-16T16:00:00) — the server applies the household timezone. Resolve relative dates (today/tomorrow/"Tue") against the current date above; allDay=true only when no clock time is given. If it REPEATS ("every Tuesday", "weekly", "every day", "monthly"), ALSO set rrule (FREQ=WEEKLY;BYDAY=TU / FREQ=DAILY / FREQ=MONTHLY / FREQ=YEARLY) with startsAt = the FIRST occurrence; otherwise rrule null.',
    '- task: recurring → rrule with two-letter weekday codes (FREQ=WEEKLY;BYDAY=MO,WE,SA) or FREQ=DAILY; one-off → rrule null.',
    '- grocery: something to BUY — the grocery/shopping list, or a bare food/household-shopping item ("add milk", "add milk to the shopping list"). "quantity" is just the amount (e.g. "2 lbs"), or null. Never prefix it with a label. NOTE: "add X to the pantry/fridge/freezer" is a PANTRY item (already on hand), not grocery.',
    '- pantry: an item you ALREADY HAVE, named with an explicit pantry/fridge/freezer destination — "add X to (the) pantry", "put X in the fridge/freezer", "we have X in the pantry". Set "name" (the item); optional "amount"+"unit" (e.g. "2"+"cans"), "location" (Pantry/Fridge/Freezer, default Pantry), "expiresOn" (YYYY-MM-DD), "lowAt". This is DIFFERENT from grocery: grocery = to buy (shopping list); pantry = already on hand. Route to pantry ONLY when the note explicitly stores it in the pantry/fridge/freezer.',
    '- list: "add X to (the) <list>" / "put X on my <list>" where <list> is a NAMED non-grocery list → kind "list" with itemName=X and listName=the list. Match listName to one of the Custom lists above when it clearly refers to one (e.g. "the lake packing trip" → "Lake trip packing"); otherwise keep the user\'s name. Optional "quantity".',
    '- "eating out" / "order in" / "takeout" / "delivery" (no clock time) → kind "meal" with title "Eating out".',
    '- meal: "meal plan", "on the menu", or "<dish> for dinner/lunch/breakfast" → kind "meal". Put the dish in "title" and set "mealType" (default "dinner"). For "date", RESOLVE any relative day (today/tomorrow/"Friday"/"next Thursday") against the current date above into YYYY-MM-DD — exactly like events do — and ONLY default to today when no day is mentioned. A specific clock time means it is an EVENT, not a meal.',
    '- countdown: a future DAY to count down to with NO clock time — a day marker, not a scheduled event. "N days until X", "X in N days", "countdown to X [on <date>]", "N sleeps until X". Set "title"=X and RESOLVE the target day into "date" (YYYY-MM-DD) exactly like meals/events (handle "in N days", explicit dates, and weekdays). Optionally set a fitting "emoji". If a clock time is given, it is an EVENT instead.',
    '- person: "add my son/daughter/husband/wife/mom/dad/… <name>", "add a family member <name>", "create a profile for <name>" → kind "person". Set "name" (just the person\'s name). Infer "memberType": son/daughter/kid/child → "kid", teen/teenager → "teen", spouse/husband/wife/partner/mom/dad/parent/adult → "adult"; default "adult" for a bare name. Optionally set "avatarEmoji" (a fitting face), "birthday" (YYYY-MM-DD) ONLY if an actual date is given, and "isAdmin" true only for a clear parent/guardian. NEVER invent a birthday from an age ("age 8" → leave birthday null).',
    '- goal: "set a goal to…", "set a personal/new/weekly goal to…", "set myself a goal to…", "I want to…", "my goal is…" → kind "goal" (an adjective like personal/new/big/weekly/family between the article and "goal" is fine). Set "title" (the goal itself). Infer "goalType": a countable target ("read 20 books") → "count" with "targetValue" (20) + "unit" ("books"); an accumulating amount ("save $500", "run 100 miles") → "total" with targetValue + unit; a recurring habit with NO number ("drink water", "get in shape", "meditate every day") → "habit"; an explicit list of steps → "checklist"; when unsure → "habit". A count/total with no number is really a habit — leave targetValue null and use "habit". Default "trackingMode" "shared_total". Optionally set "deadline" (YYYY-MM-DD) when a date is given ("this year" → Dec 31 of this year; "by september" → the last day of the next September). Set "audience" from the phrasing: "everyone" for a family/shared/together goal ("set a family goal", "our goal", "we want to…"), "me" for a personal one ("personal goal", "my own", "I want to…"), else null.',
    '- reward: "add a reward: <name> for N stars", "new reward <name> costs N points", "reward: <name>" → kind "reward". Set "title" (the reward name) and, when a star/point price is given, "cost" (the whole number N). Trigger only on the explicit word "reward". Optionally set "emoji". This is the reward SHOP catalog, NOT awarding stars for a chore.',
    '- unsupported: if the note is a reminder/notification, or anything that is not an event, task/chore, grocery item, meal, list item, countdown, family member, goal, or reward, return kind "unsupported" with a short friendly "reason". Do NOT force it into another kind.',
    '- stars = the integer reward if mentioned, else null.',
    '',
    'Examples below ASSUME today is Thursday June 11 2026. Always recompute dates from the ACTUAL current date stated above, not from this example date:',
    '"Soccer Tue 4pm for Wally" -> {"kind":"event","title":"Soccer","personName":"Wally","startsAt":"2026-06-16T16:00:00","allDay":false}',
    '"soccer every Tuesday at 4pm for Wally" -> {"kind":"event","title":"Soccer","personName":"Wally","startsAt":"2026-06-16T16:00:00","allDay":false,"rrule":"FREQ=WEEKLY;BYDAY=TU"}',
    '"book club on the first Monday of every month at 7pm" -> {"kind":"event","title":"Book club","startsAt":"2026-07-06T19:00:00","allDay":false,"rrule":"FREQ=MONTHLY;BYDAY=1MO"}',
    '"dentist tomorrow" -> {"kind":"event","title":"Dentist","personName":null,"startsAt":"2026-06-12T00:00:00","allDay":true}',
    '"Please add laundry for Monday and Saturday to Kelly\'s chore list" -> {"kind":"task","title":"Laundry","personName":"Kelly","rrule":"FREQ=WEEKLY;BYDAY=MO,SA","stars":null}',
    '"\\"Take Out the Trash\\" for Lottie on Tuesday and Thursday" -> {"kind":"task","title":"Take Out the Trash","personName":"Lottie","rrule":"FREQ=WEEKLY;BYDAY=TU,TH"}',
    '"grab 2 lbs of chicken thighs" -> {"kind":"grocery","name":"chicken thighs","quantity":"2 lbs"}',
    '"add milk to the shopping list" -> {"kind":"grocery","name":"milk","quantity":null}',
    '"add 2 cans of beans to the pantry" -> {"kind":"pantry","name":"Beans","amount":"2","unit":"cans","location":"Pantry"}',
    '"we have a gallon of milk in the fridge" -> {"kind":"pantry","name":"Milk","amount":"1","unit":"gallon","location":"Fridge"}',
    '"add towels to the lake packing trip" -> {"kind":"list","itemName":"Towels","listName":"Lake trip packing"}',
    '"put sunscreen and goggles on the beach list" -> {"kind":"list","itemName":"Sunscreen and goggles","listName":"Beach"}',
    '"lets put shawarma on the meal plan" -> {"kind":"meal","title":"Shawarma","mealType":"dinner"}',
    '"tacos for lunch on Friday" -> {"kind":"meal","title":"Tacos","mealType":"lunch","date":"2026-06-12"}',
    '"I want fish for dinner next Thursday" -> {"kind":"meal","title":"Fish","mealType":"dinner","date":"2026-06-18"}',
    '"we\'re eating out Friday" -> {"kind":"meal","title":"Eating out","mealType":"dinner","date":"2026-06-12"}',
    '"12 days until Disney" -> {"kind":"countdown","title":"Disney","date":"2026-06-23","emoji":"🏰"}',
    '"add a countdown for thanksgiving" -> {"kind":"countdown","title":"Thanksgiving","date":"2026-11-26","emoji":"🦃"}',
    '"countdown for november 20th" -> {"kind":"countdown","title":"Countdown","date":"2026-11-20","emoji":"⏳"}',
    '"add my son Max" -> {"kind":"person","name":"Max","memberType":"kid","avatarEmoji":"👦"}',
    '"add a family member named Jane" -> {"kind":"person","name":"Jane","memberType":"adult"}',
    '"set a goal to read 20 books this year" -> {"kind":"goal","title":"Read 20 books","goalType":"count","targetValue":20,"unit":"books","trackingMode":"shared_total","deadline":"2026-12-31"}',
    '"set a personal goal to run 10 miles by september" -> {"kind":"goal","title":"Run 10 miles","goalType":"total","targetValue":10,"unit":"miles","trackingMode":"shared_total","deadline":"2026-09-30"}',
    '"I want to get in shape" -> {"kind":"goal","title":"Get in shape","goalType":"habit","trackingMode":"shared_total"}',
    '"my goal is to save $500" -> {"kind":"goal","title":"Save $500","goalType":"total","targetValue":500,"unit":"dollars","trackingMode":"shared_total"}',
    '"add a reward: ice cream night for 50 stars" -> {"kind":"reward","title":"Ice cream night","cost":50,"emoji":"🍦"}',
    '"new reward extra screen time costs 100 points" -> {"kind":"reward","title":"Extra screen time","cost":100}',
  ].join('\n')
}

// ── Normalize a raw model object into a finished CaptureIntent ────────────────
export function finalizeIntent(raw: unknown, ctx: CaptureContext): CaptureIntent {
  const r = (raw ?? {}) as Record<string, unknown>
  const kindRaw = String(r.kind ?? '').toLowerCase()
  const kind: CaptureIntent['kind'] = (['event', 'grocery', 'meal', 'list', 'countdown', 'person', 'goal', 'pantry', 'reward', 'unsupported'] as const).find((k) => k === kindRaw) ?? 'task'

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
  if (kind === 'pantry') {
    const name = String(r.name ?? r.title ?? '').trim()
    if (!name) throw new Error('pantry: no item')
    // amount/unit are free-text (the route stores them as strings); location defaults
    // to 'Pantry'; expiresOn is kept only if a real ISO day; lowAt only if a number ≥ 0.
    const amount = r.amount != null && String(r.amount).trim() ? String(r.amount).trim() : null
    const unit = r.unit != null && String(r.unit).trim() ? String(r.unit).trim() : null
    const location = r.location != null && String(r.location).trim() ? String(r.location).trim() : 'Pantry'
    const expiresOn = typeof r.expiresOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.expiresOn) ? r.expiresOn : null
    const rawLow = typeof r.lowAt === 'number' ? r.lowAt : Number(r.lowAt)
    // Require an actual value: Number(null) === 0 would otherwise turn a schema-emitted
    // `lowAt: null` into a real threshold of 0 (silently disabling the low-stock warning).
    const lowAt = r.lowAt != null && Number.isFinite(rawLow) && rawLow >= 0 ? rawLow : null
    return { kind, name, amount, unit, location, expiresOn, lowAt }
  }
  if (kind === 'reward') {
    const title = String(r.title ?? r.name ?? '').trim()
    if (!title) throw new Error('reward: no title')
    const emoji = r.emoji ? String(r.emoji).trim() || null : null
    // cost: a non-negative whole number (round floats, clamp negatives to 0), mirroring
    // the route's `Math.max(0, Math.round(...))`; null when no price is given.
    const rawCost = typeof r.cost === 'number' ? r.cost : Number(r.cost)
    const cost = r.cost != null && Number.isFinite(rawCost) ? Math.max(0, Math.round(rawCost)) : null
    const currency = r.currency != null && String(r.currency).trim() ? String(r.currency).trim() : null
    const category = r.category != null && String(r.category).trim() ? String(r.category).trim() : null
    // Passthrough: keep an explicit boolean; else null so the route inherits the
    // household's reward-approval default.
    const requiresApproval = typeof r.requiresApproval === 'boolean' ? r.requiresApproval : null
    return { kind, title, emoji, cost, currency, category, requiresApproval }
  }
  if (kind === 'meal') {
    const title = String(r.title ?? r.name ?? '').trim()
    if (!title) throw new Error('meal: no dish')
    const mt = String(r.mealType ?? 'dinner').toLowerCase()
    const mealType = MEAL_TYPES.has(mt) ? mt : 'dinner'
    const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : todayInTz(ctx.timezone)
    return { kind, title, date, mealType, whenLabel: `${mealDayLabel(date, ctx.timezone)} · ${cap(mealType)}` }
  }
  if (kind === 'countdown') {
    const title = String(r.title ?? r.name ?? '').trim()
    if (!title) throw new Error('countdown: no title')
    // Accept an ISO day as-is; a loose day ("in 12 days"/"friday") resolves like meals.
    const date =
      typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
        ? r.date
        : typeof r.date === 'string'
          ? resolveDayFromText(r.date, ctx.timezone)
          : null
    if (!date) throw new Error('countdown: no date')
    const emoji = r.emoji ? String(r.emoji).trim() || null : null
    return { kind, title, date, emoji, whenLabel: countdownWhenLabel(date, ctx.timezone) }
  }
  if (kind === 'person') {
    const name = String(r.name ?? r.title ?? '').trim()
    if (!name) throw new Error('person: no name')
    const mt = String(r.memberType ?? '').toLowerCase()
    const memberType = (['adult', 'teen', 'kid'] as const).find((t) => t === mt) ?? 'adult'
    const avatarEmoji = r.avatarEmoji ? String(r.avatarEmoji).trim() || null : null
    // Only a real ISO day — never an age. The prompt is told not to invent one either.
    const birthday = typeof r.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.birthday) ? r.birthday : null
    const isAdmin = r.isAdmin == null ? false : !!r.isAdmin
    return { kind, name, memberType, avatarEmoji, birthday, isAdmin }
  }
  if (kind === 'goal') {
    const title = String(r.title ?? r.name ?? '').trim()
    if (!title) throw new Error('goal: no title')
    // A real numeric target (finite number); count/total need one — else it's a habit.
    const rawTarget = typeof r.targetValue === 'number' ? r.targetValue : Number(r.targetValue)
    const targetValue = Number.isFinite(rawTarget) && rawTarget > 0 ? rawTarget : null
    // Mirror the route's shape rule (goals.service GOAL_TYPES + goalShapeError): coerce
    // to the enum, and downgrade a count/total with no real number to a plain habit.
    let goalType = (['count', 'total', 'habit', 'checklist'] as const).find((t) => t === String(r.goalType ?? '').toLowerCase()) ?? 'habit'
    if ((goalType === 'count' || goalType === 'total') && targetValue == null) goalType = 'habit'
    // A count target must be a whole number (the route rejects a fractional one).
    const cleanTarget = goalType === 'count' && targetValue != null ? Math.round(targetValue) : targetValue
    const trackingMode = (['shared_total', 'each_tracks'] as const).find((m) => m === String(r.trackingMode ?? '').toLowerCase()) ?? 'shared_total'
    // Assignment shape (mirrors GoalCreate's create payload): participantMode + targetBasis,
    // carried through so the client's "who's it for" choice round-trips, coerced to the enum
    // with the same defaults the route uses (count_once / family).
    const participantMode = (['count_once', 'split'] as const).find((m) => m === String(r.participantMode ?? '').toLowerCase()) ?? 'count_once'
    const targetBasis = (['family', 'per_person'] as const).find((b) => b === String(r.targetBasis ?? '').toLowerCase()) ?? 'family'
    const unit = r.unit && (goalType === 'count' || goalType === 'total') ? String(r.unit).trim() || null : null
    const deadline = typeof r.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.deadline) ? r.deadline : null
    // Inferred who-hint that seeds the client's "who's it for" control; coerce to the enum.
    const audience = (['me', 'everyone'] as const).find((a) => a === String(r.audience ?? '').toLowerCase()) ?? null
    return { kind, title, goalType, trackingMode, participantMode, targetBasis, targetValue: cleanTarget, unit, deadline, audience, participantIds: [] }
  }
  if (kind === 'event') {
    const raw0 = r.startsAt ? String(r.startsAt) : null
    if (!raw0 || Number.isNaN(Date.parse(zonedToUtc(raw0, ctx.timezone)))) throw new Error('event: bad startsAt')
    const startsAt = zonedToUtc(raw0, ctx.timezone)
    const allDay = r.allDay == null ? true : !!r.allDay
    const rrule = r.rrule ? String(r.rrule) : null
    return {
      kind,
      title: String(r.title ?? 'Event').trim() || 'Event',
      startsAt,
      allDay,
      personName,
      rrule,
      scheduleLabel: scheduleLabel(rrule),
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
// Keep meaningful nouns ("trip"/"packing") — drop only filler — so "my lake trip"
// still snaps to "Lake trip packing".
const normList = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an|my|our|list|to|for)\b/g, ' ').replace(/\s+/g, ' ').trim()

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

// Holiday resolution — a known holiday name → its NEXT occurrence on/after today
// (UTC math, mirroring the rest of this function). KEEP IN SYNC with the web/Swift
// `findHoliday` heuristics.
function nthWeekdayUTC(year: number, month0: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month0, 1))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month0, 1 + offset + (n - 1) * 7))
}
function lastWeekdayUTC(year: number, month0: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month0 + 1, 0)) // day 0 of next month = last day of this
  const offset = (last.getUTCDay() - weekday + 7) % 7
  return new Date(Date.UTC(year, month0, last.getUTCDate() - offset))
}
function easterSundayUTC(year: number): Date {
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
  return new Date(Date.UTC(year, month - 1, day))
}
const HOLIDAYS: { re: RegExp; calc: (y: number) => Date }[] = [
  { re: /\bnew\s+year'?s?\s+eve\b/, calc: (y) => new Date(Date.UTC(y, 11, 31)) },
  { re: /\bnew\s+year'?s?(?:\s+day)?\b/, calc: (y) => new Date(Date.UTC(y, 0, 1)) },
  { re: /\bvalentine'?s?(?:\s+day)?\b/, calc: (y) => new Date(Date.UTC(y, 1, 14)) },
  { re: /\bst\.?\s+patrick'?s?(?:\s+day)?\b/, calc: (y) => new Date(Date.UTC(y, 2, 17)) },
  { re: /\bcinco\s+de\s+mayo\b/, calc: (y) => new Date(Date.UTC(y, 4, 5)) },
  { re: /\bjuneteenth\b/, calc: (y) => new Date(Date.UTC(y, 5, 19)) },
  { re: /\b(?:independence\s+day|july\s+4th|july\s+4|4th\s+of\s+july|fourth\s+of\s+july)\b/, calc: (y) => new Date(Date.UTC(y, 6, 4)) },
  { re: /\bhalloween\b/, calc: (y) => new Date(Date.UTC(y, 9, 31)) },
  { re: /\bveterans'?\s+day\b/, calc: (y) => new Date(Date.UTC(y, 10, 11)) },
  { re: /\bchristmas\s+eve\b/, calc: (y) => new Date(Date.UTC(y, 11, 24)) },
  { re: /\b(?:christmas|xmas)\b/, calc: (y) => new Date(Date.UTC(y, 11, 25)) },
  { re: /\bmlk(?:\s+day)?\b|\bmartin\s+luther\s+king(?:\s+jr\.?)?(?:\s+day)?\b/, calc: (y) => nthWeekdayUTC(y, 0, 1, 3) },
  { re: /\bpresidents'?\s+day\b/, calc: (y) => nthWeekdayUTC(y, 1, 1, 3) },
  { re: /\bmother'?s?\s+day\b/, calc: (y) => nthWeekdayUTC(y, 4, 0, 2) },
  { re: /\bmemorial\s+day\b/, calc: (y) => lastWeekdayUTC(y, 4, 1) },
  { re: /\bfather'?s?\s+day\b/, calc: (y) => nthWeekdayUTC(y, 5, 0, 3) },
  { re: /\blabor\s+day\b/, calc: (y) => nthWeekdayUTC(y, 8, 1, 1) },
  { re: /\bthanksgiving\b/, calc: (y) => nthWeekdayUTC(y, 10, 4, 4) },
  { re: /\bgood\s+friday\b/, calc: (y) => new Date(easterSundayUTC(y).getTime() - 2 * 86_400_000) },
  { re: /\beaster\b/, calc: (y) => easterSundayUTC(y) },
]

// Deterministically resolve a calendar day from free text (today/tomorrow,
// a weekday optionally with "next", "in N days", a holiday name, a month+day, or
// m/d) → the model is unreliable at date math, so we do it ourselves. null = no day.
export function resolveDayFromText(text: string, tz: string, opts?: { holidays?: boolean }): string | null {
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

  // "N days/sleeps until/til/till/to/before X" — mirrors the web CD_UNTIL regex so a
  // countdown counts N days out, never getting hijacked by a holiday word in X.
  const until = /\b(\d{1,3})\s+(?:days?|sleeps?)\s+(?:until|til|till|to|before)\b/.exec(t)
  if (until) return add(parseInt(until[1], 10))

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
  // Holidays LAST and matched anywhere in the text — so an explicit month+day or m/d
  // wins over a stray holiday word (e.g. "christmas party on june 20" → June 20). Skip
  // entirely when the caller opts out (a holiday word in a meal dish must not set a date).
  if (opts?.holidays !== false) {
    for (const h of HOLIDAYS) {
      if (!h.re.test(t)) continue
      let d = h.calc(base.getUTCFullYear())
      if (d.getTime() < base.getTime()) d = h.calc(base.getUTCFullYear() + 1)
      return iso(d)
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

// A countdown's preview label — the target day plus how far off it is.
function countdownWhenLabel(date: string, tz: string): string {
  const today = todayInTz(tz)
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const rel = diff <= 0 ? 'Today' : diff === 1 ? 'Tomorrow' : `${diff} days`
  return `${day} · ${rel}`
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
  if (/FREQ=MONTHLY/i.test(rrule)) return 'Every month'
  if (/FREQ=YEARLY/i.test(rrule)) return 'Every year'
  const m = /BYDAY=([A-Z,]+)/i.exec(rrule)
  if (!m) return /FREQ=WEEKLY/i.test(rrule) ? 'Every week' : ''
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
    // Holidays OFF: a dish name like "christmas ham" must not silently set a meal date.
    const resolved = resolveDayFromText(text, ctx.timezone, { holidays: false })
    if (resolved && resolved !== intent.date) {
      intent.date = resolved
      intent.whenLabel = `${mealDayLabel(resolved, ctx.timezone)} · ${cap(intent.mealType ?? 'dinner')}`
    }
  }
  // Likewise for a countdown: trust the deterministic day parse over the model's.
  if (intent.kind === 'countdown') {
    const resolved = resolveDayFromText(text, ctx.timezone)
    if (resolved && resolved !== intent.date) {
      intent.date = resolved
      intent.whenLabel = countdownWhenLabel(resolved, ctx.timezone)
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
  api.post('/api/capture/warm', tenantRoute(async (tenant) => {
    void warmProvider(tenant.householdId)
    return { warming: true }
  }))

  // Parse free text → intent. On any failure, tell the client to fall back to
  // its on-device heuristic (200 with fallback:true, not an error).
  api.post('/api/capture', tenantRoute(async (tenant, req: Request) => {
    const text = String((req.body as { text?: unknown })?.text ?? '').trim()
    if (!text) return { intent: null, via: 'heuristic', fallback: true }
    try {
      const { intent, via } = await parseWithProvider(tenant.householdId, text)
      return { intent, via, fallback: false }
    } catch (err) {
      return { intent: null, via: 'heuristic', fallback: true, error: (err as Error).message }
    }
  }))

  // Current selection + which providers the environment makes available + the
  // default model for each. Never returns secrets.
  api.get('/api/capture/config', adminRoute(async (tenant) => {
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
  }))

  // Flip the active provider/model (admins only).
  api.put('/api/capture/config', adminRoute(async (tenant, req: Request, res: Response) => {
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
  }))
}
