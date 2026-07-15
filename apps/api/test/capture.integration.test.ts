// Capture parsing — provider config endpoints + heuristic fallback against a real
// PG, plus pure intent-finalization unit checks. (LLM adapters hit external HTTP
// and aren't exercised here; finalizeIntent covers the mapping they feed into.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { finalizeIntent, resolveDayFromText } from '../src/modules/capture/capture'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

let kevin = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('capture config endpoints', () => {
  it('defaults to the on-device heuristic with no providers configured', async () => {
    const res = await call('GET', '/api/capture/config', kevin)
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.provider).toBe('heuristic')
    expect(d.available.heuristic).toBe(true)
    expect(d.available.anthropic).toBe(false)
    expect(d.available.ollama).toBe(false)
  })

  it('rejects selecting a provider with no server credentials', async () => {
    const res = await call('PUT', '/api/capture/config', kevin, { provider: 'anthropic' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown provider', async () => {
    expect((await call('PUT', '/api/capture/config', kevin, { provider: 'bogus' })).statusCode).toBe(400)
  })

  it('persists a heuristic selection and round-trips it', async () => {
    expect((await call('PUT', '/api/capture/config', kevin, { provider: 'heuristic' })).statusCode).toBe(200)
    const d = JSON.parse((await call('GET', '/api/capture/config', kevin)).body)
    expect(d.provider).toBe('heuristic')
  })

  it('POST /api/capture defers to the client when the provider is heuristic', async () => {
    const res = await call('POST', '/api/capture', kevin, { text: 'milk' })
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.fallback).toBe(true)
    expect(d.intent).toBeNull()
  })
})

describe('finalizeIntent — model JSON → finished intent', () => {
  const ctx = { now: '2026-06-11T09:00:00Z', timezone: 'America/Chicago', people: ['Wally', 'Lottie'] }

  it('maps a grocery item', () => {
    expect(finalizeIntent({ kind: 'grocery', name: 'chicken thighs', quantity: '2 lbs' }, ctx)).toEqual({
      kind: 'grocery', name: 'chicken thighs', quantity: '2 lbs',
    })
  })

  it('maps a recurring chore and labels the schedule', () => {
    const i = finalizeIntent({ kind: 'task', title: 'Take out the trash', personName: 'lottie', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' }, ctx)
    expect(i).toMatchObject({ kind: 'task', title: 'Take out the trash', personName: 'Lottie', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', scheduleLabel: 'Tue & Thu' })
  })

  it('drops a person who is not in the family', () => {
    const i = finalizeIntent({ kind: 'task', title: 'X', personName: 'Stranger' }, ctx)
    expect(i.personName).toBeNull()
  })

  it('maps an event and builds a when-label', () => {
    const i = finalizeIntent({ kind: 'event', title: 'Soccer', startsAt: '2026-06-16T21:00:00Z', allDay: false }, ctx)
    expect(i.kind).toBe('event')
    expect(i.whenLabel).toMatch(/·/)
  })

  it('interprets a naive local datetime in the household timezone', () => {
    // 4pm naive, household America/Chicago (CDT -05:00) → 21:00 UTC.
    const i = finalizeIntent({ kind: 'event', title: 'Soccer', startsAt: '2026-06-16T16:00:00', allDay: false }, ctx)
    expect(i.startsAt).toBe('2026-06-16T21:00:00.000Z')
    expect(i.whenLabel).toContain('4:00')
  })

  it('rejects an event with no valid start', () => {
    expect(() => finalizeIntent({ kind: 'event', title: 'x', startsAt: 'not-a-date' }, ctx)).toThrow()
  })

  it('maps a meal, defaulting to dinner + today', () => {
    const i = finalizeIntent({ kind: 'meal', title: 'Shawarma' }, ctx)
    expect(i.kind).toBe('meal')
    expect(i.title).toBe('Shawarma')
    expect(i.mealType).toBe('dinner')
    expect(i.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(i.whenLabel).toContain('Dinner')
  })

  it('keeps an explicit meal date + slot', () => {
    const i = finalizeIntent({ kind: 'meal', title: 'Tacos', mealType: 'lunch', date: '2026-06-12' }, ctx)
    expect(i.mealType).toBe('lunch')
    expect(i.date).toBe('2026-06-12')
  })

  it('maps a countdown with an explicit date + emoji', () => {
    const i = finalizeIntent({ kind: 'countdown', title: 'Disney', date: '2026-08-25', emoji: '🏰' }, ctx)
    expect(i.kind).toBe('countdown')
    expect(i.title).toBe('Disney')
    expect(i.date).toBe('2026-08-25')
    expect(i.emoji).toBe('🏰')
    expect(i.whenLabel).toMatch(/·/)
  })

  it('resolves a loose countdown date ("in 12 days") deterministically', () => {
    const i = finalizeIntent({ kind: 'countdown', title: 'Vacation', date: 'in 12 days' }, ctx)
    expect(i.kind).toBe('countdown')
    // A non-ISO date is run through resolveDayFromText (same as the meal path).
    expect(i.date).toBe(resolveDayFromText('in 12 days', ctx.timezone))
    expect(i.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('resolves a holiday-name countdown date ("thanksgiving") to the next Thanksgiving', () => {
    const i = finalizeIntent({ kind: 'countdown', title: 'Thanksgiving', date: 'thanksgiving' }, ctx)
    expect(i.kind).toBe('countdown')
    expect(i.title).toBe('Thanksgiving')
    // Deterministic holiday resolution — the 4th Thursday of November, on/after today.
    expect(i.date).toBe(resolveDayFromText('thanksgiving', ctx.timezone))
    const d = new Date(`${i.date}T00:00:00Z`)
    expect(d.getUTCDay()).toBe(4) // Thursday
    expect(d.getUTCMonth()).toBe(10) // November
    expect(d.getUTCDate()).toBeGreaterThanOrEqual(22) // 4th Thursday is always the 22nd–28th
    expect(d.getUTCDate()).toBeLessThanOrEqual(28)
  })

  it('rejects a countdown with no usable date', () => {
    expect(() => finalizeIntent({ kind: 'countdown', title: 'Someday' }, ctx)).toThrow()
  })

  it('rejects a countdown with no title', () => {
    expect(() => finalizeIntent({ kind: 'countdown', date: '2026-08-25' }, ctx)).toThrow()
  })

  it('maps a person with an explicit memberType', () => {
    const i = finalizeIntent({ kind: 'person', name: 'Max', memberType: 'kid', avatarEmoji: '👦' }, ctx)
    expect(i.kind).toBe('person')
    expect(i.name).toBe('Max')
    expect(i.memberType).toBe('kid')
    expect(i.avatarEmoji).toBe('👦')
    expect(i.isAdmin).toBe(false)
  })

  it('defaults a person memberType to adult when missing', () => {
    const i = finalizeIntent({ kind: 'person', name: 'Jane' }, ctx)
    expect(i.kind).toBe('person')
    expect(i.memberType).toBe('adult')
  })

  it('coerces a bogus person memberType to adult', () => {
    expect(finalizeIntent({ kind: 'person', name: 'Sam', memberType: 'grandpa' }, ctx).memberType).toBe('adult')
  })

  it('keeps a valid person birthday but drops a non-ISO one (never invents from an age)', () => {
    expect(finalizeIntent({ kind: 'person', name: 'Max', memberType: 'kid', birthday: '2018-06-05' }, ctx).birthday).toBe('2018-06-05')
    expect(finalizeIntent({ kind: 'person', name: 'Max', memberType: 'kid', birthday: 'age 8' }, ctx).birthday).toBeNull()
  })

  it('rejects a person with no name', () => {
    expect(() => finalizeIntent({ kind: 'person', memberType: 'kid' }, ctx)).toThrow()
  })

  it('maps a count goal with an explicit numeric target + unit', () => {
    expect(finalizeIntent(
      { kind: 'goal', title: 'Read 20 books', goalType: 'count', targetValue: 20, unit: 'books' }, ctx
    )).toEqual({
      kind: 'goal', title: 'Read 20 books', goalType: 'count',
      trackingMode: 'shared_total', participantMode: 'count_once', targetBasis: 'family',
      targetValue: 20, unit: 'books', deadline: null, audience: null,
    })
  })

  it('carries the goal audience through (defaulting null, coercing bogus)', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'Family walk', audience: 'everyone' }, ctx).audience).toBe('everyone')
    expect(finalizeIntent({ kind: 'goal', title: 'My run', audience: 'me' }, ctx).audience).toBe('me')
    expect(finalizeIntent({ kind: 'goal', title: 'Read', goalType: 'count', targetValue: 5 }, ctx).audience).toBeNull()
    expect(finalizeIntent({ kind: 'goal', title: 'X', audience: 'nonsense' }, ctx).audience).toBeNull()
  })

  it('carries explicit goal assignment fields (trackingMode/participantMode/targetBasis) through', () => {
    const i = finalizeIntent(
      { kind: 'goal', title: 'Family miles', goalType: 'total', targetValue: 100, unit: 'miles', trackingMode: 'each_tracks', participantMode: 'split', targetBasis: 'per_person' },
      ctx
    )
    expect(i).toMatchObject({ trackingMode: 'each_tracks', participantMode: 'split', targetBasis: 'per_person', unit: 'miles' })
  })

  it('defaults the goal assignment fields sensibly when absent', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'Get in shape' }, ctx)).toMatchObject({
      trackingMode: 'shared_total', participantMode: 'count_once', targetBasis: 'family',
    })
  })

  it('coerces bogus goal assignment fields to their defaults', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'X', goalType: 'count', targetValue: 3, participantMode: 'nope', targetBasis: 'bogus' }, ctx))
      .toMatchObject({ participantMode: 'count_once', targetBasis: 'family' })
  })

  it('maps an accumulating total goal, keeping the target', () => {
    const i = finalizeIntent({ kind: 'goal', title: 'Save $500', goalType: 'total', targetValue: 500, unit: 'dollars' }, ctx)
    expect(i).toMatchObject({ kind: 'goal', title: 'Save $500', goalType: 'total', trackingMode: 'shared_total', targetValue: 500, unit: 'dollars' })
  })

  it('defaults a bare goal ("get in shape") to a habit with no target', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'Get in shape' }, ctx)).toMatchObject({
      kind: 'goal', title: 'Get in shape', goalType: 'habit', trackingMode: 'shared_total',
    })
  })

  it('downgrades a count goal with no number to a habit', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'Drink water', goalType: 'count' }, ctx))
      .toMatchObject({ goalType: 'habit' })
  })

  it('keeps a valid goal deadline but drops a non-ISO one', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'Read 20 books', goalType: 'count', targetValue: 20, deadline: '2026-12-31' }, ctx).deadline).toBe('2026-12-31')
    expect(finalizeIntent({ kind: 'goal', title: 'Read 20 books', goalType: 'count', targetValue: 20, deadline: 'this year' }, ctx).deadline).toBeNull()
  })

  it('coerces a bogus goalType to habit', () => {
    expect(finalizeIntent({ kind: 'goal', title: 'Be kind', goalType: 'nonsense' }, ctx).goalType).toBe('habit')
  })

  it('rejects a goal with no title', () => {
    expect(() => finalizeIntent({ kind: 'goal', goalType: 'habit' }, ctx)).toThrow()
  })

  it('maps a pantry item with amount + unit, defaulting location to Pantry', () => {
    expect(finalizeIntent({ kind: 'pantry', name: 'Beans', amount: '2', unit: 'cans' }, ctx)).toEqual({
      kind: 'pantry', name: 'Beans', amount: '2', unit: 'cans', location: 'Pantry', expiresOn: null, lowAt: null,
    })
  })

  it('keeps an explicit pantry location and a low-stock threshold', () => {
    const i = finalizeIntent({ kind: 'pantry', name: 'Milk', location: 'Fridge', lowAt: 1 }, ctx)
    expect(i).toMatchObject({ kind: 'pantry', name: 'Milk', location: 'Fridge', lowAt: 1 })
  })

  it('keeps a valid pantry expiresOn but drops a non-ISO one', () => {
    expect(finalizeIntent({ kind: 'pantry', name: 'Milk', expiresOn: '2026-08-01' }, ctx).expiresOn).toBe('2026-08-01')
    expect(finalizeIntent({ kind: 'pantry', name: 'Milk', expiresOn: 'next week' }, ctx).expiresOn).toBeNull()
  })

  it('rejects a pantry item with no name', () => {
    expect(() => finalizeIntent({ kind: 'pantry', amount: '2' }, ctx)).toThrow()
  })

  // Grocery vs pantry stay distinct kinds — an item to BUY is grocery; an item ON
  // HAND (explicit pantry target) is pantry. finalizeIntent honors the kind it's given.
  it('keeps grocery and pantry as separate kinds (no conflation)', () => {
    expect(finalizeIntent({ kind: 'grocery', name: 'Milk' }, ctx).kind).toBe('grocery')
    expect(finalizeIntent({ kind: 'pantry', name: 'Milk' }, ctx).kind).toBe('pantry')
  })

  it('maps a reward with emoji + cost, defaulting the rest to null', () => {
    expect(finalizeIntent({ kind: 'reward', title: 'Ice cream night', emoji: '🍦', cost: 50 }, ctx)).toEqual({
      kind: 'reward', title: 'Ice cream night', emoji: '🍦', cost: 50, currency: null, category: null, requiresApproval: null,
    })
  })

  it('coerces a reward cost to a non-negative integer (rounds floats, clamps negatives to 0)', () => {
    expect(finalizeIntent({ kind: 'reward', title: 'X', cost: 49.6 }, ctx).cost).toBe(50)
    expect(finalizeIntent({ kind: 'reward', title: 'X', cost: -5 }, ctx).cost).toBe(0)
    // "50" (string) still coerces to the integer 50.
    expect(finalizeIntent({ kind: 'reward', title: 'X', cost: '50' }, ctx).cost).toBe(50)
  })

  it('leaves a reward cost null when none is given', () => {
    expect(finalizeIntent({ kind: 'reward', title: 'Movie night' }, ctx).cost).toBeNull()
  })

  it('passes requiresApproval through, else leaves it null (inherit household default)', () => {
    expect(finalizeIntent({ kind: 'reward', title: 'X', requiresApproval: true }, ctx).requiresApproval).toBe(true)
    expect(finalizeIntent({ kind: 'reward', title: 'X', requiresApproval: false }, ctx).requiresApproval).toBe(false)
    expect(finalizeIntent({ kind: 'reward', title: 'X' }, ctx).requiresApproval).toBeNull()
  })

  it('rejects a reward with no title', () => {
    expect(() => finalizeIntent({ kind: 'reward', cost: 50 }, ctx)).toThrow()
  })
})

describe('resolveDayFromText — deterministic meal day (model-independent)', () => {
  const tz = 'America/Chicago'
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay()
  const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000

  it('returns null when no day is mentioned', () => {
    expect(resolveDayFromText('shawarma on the meal plan', tz)).toBeNull()
  })
  it('"tomorrow" is exactly one day after today', () => {
    expect(days(resolveDayFromText('today', tz)!, resolveDayFromText('burgers tomorrow', tz)!)).toBe(1)
  })
  it('resolves a weekday to that weekday', () => {
    expect(dow(resolveDayFromText('fish for dinner on friday', tz)!)).toBe(5)
    expect(dow(resolveDayFromText('fish for dinner next thursday', tz)!)).toBe(4)
  })
  it('"next <weekday>" lands 7–13 days out', () => {
    const d = days(resolveDayFromText('today', tz)!, resolveDayFromText('next thursday', tz)!)
    expect(d).toBeGreaterThanOrEqual(7)
    expect(d).toBeLessThanOrEqual(13)
  })
  it('resolves a fixed-date holiday name ("christmas") to Dec 25', () => {
    const c = resolveDayFromText('christmas', tz)!
    expect(c).toMatch(/-12-25$/)
    // Never in the past relative to today.
    expect(days(resolveDayFromText('today', tz)!, c)).toBeGreaterThanOrEqual(0)
  })
  it('resolves a computed holiday name ("thanksgiving") to the 4th Thursday of November', () => {
    const t = resolveDayFromText('thanksgiving', tz)!
    const d = new Date(`${t}T00:00:00Z`)
    expect(d.getUTCDay()).toBe(4)
    expect(d.getUTCMonth()).toBe(10)
  })
})
