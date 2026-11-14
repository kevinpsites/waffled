// The /mcp write tools: find_* candidates over the capture registry, the per-verb action
// tools that apply them, and the create tools. Each runs the same capability checks as
// its route, and every call lands one mcp_audit row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startMcpHarness, bearer, keyed, json, type McpHarness } from './helpers/mcp'
import { localYmd, zonedToUtc } from '../src/modules/capture/tz'

const TZ = 'America/Chicago'
let h: McpHarness
let kevin = ''
let kelly = { id: '', token: '' }
let wally = { id: '', token: '' }
let today = ''
let tomorrow = ''

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const lastAudit = async () =>
  (await h.sql<{ tool: string; outcome: string; error: string | null; target_ids: Record<string, unknown>; api_key_id: string | null; person_id: string }>(
    `select tool, outcome, error, target_ids, api_key_id, person_id from mcp_audit where household_id = $1 order by created_at desc limit 1`,
    [h.householdId]
  ))[0]

async function findOne(headers: Record<string, string>, tool: string, description: string, verb?: string) {
  const res = await h.tool(headers, tool, { description, ...(verb ? { verb } : {}) })
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
  expect(res.structuredContent.candidates.length).toBeGreaterThan(0)
  return res.structuredContent.candidates[0] as { id: string; title: string; subtitle?: string; confidence: number }
}

beforeAll(async () => {
  h = await startMcpHarness()
  kevin = h.owner
  kelly = await h.addMember('Kelly', 'adult')
  wally = await h.addMember('Wally', 'kid')
  today = localYmd(new Date(), TZ)
  tomorrow = addDays(today, 1)

  expect((await h.call('POST', '/api/chores', kevin, { title: 'Feed the cat', personId: wally.id })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/chores', kevin, { title: 'Walk the dog', personId: wally.id })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/lists/grocery/items', kevin, { name: 'Milk' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/lists/grocery/items', kevin, { name: 'Bread' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/events', kevin, { title: 'Soccer practice', startsAt: zonedToUtc(`${tomorrow}T12:00`, TZ) })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/events', kevin, { title: 'Piano lesson', startsAt: zonedToUtc(`${tomorrow}T15:00`, TZ), rrule: 'FREQ=WEEKLY' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/goals', kevin, { title: 'Reading minutes', goalType: 'total', unit: 'minutes', targetValue: 600, trackingMode: 'shared_total' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/rewards', kevin, { title: 'Ice cream night', cost: 5, requiresApproval: false })).statusCode).toBe(201)
  expect((await h.call('POST', `/api/persons/${wally.id}/award`, kevin, { amount: 20 })).statusCode).toBe(201)
  expect((await h.call('POST', `/api/persons/${kelly.id}/award`, kevin, { amount: 20 })).statusCode).toBe(201)
})

afterAll(async () => {
  await h?.close()
})

describe('chores', () => {
  it('find_chores returns candidates; complete_chore applies one and is audited', async () => {
    const c = await findOne(bearer(kevin), 'find_chores', 'the cat chore', 'complete')
    expect(c.title).toBe('Feed the cat')
    const res = await h.tool(bearer(kevin), 'complete_chore', { id: c.id })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(res.structuredContent.message).toMatch(/Feed the cat/)
    const listed = await h.tool(bearer(kevin), 'list_chores', { personId: wally.id })
    expect(listed.structuredContent.items.find((i: { title: string }) => i.title === 'Feed the cat').status).toBe('done')
    expect(await lastAudit()).toMatchObject({ tool: 'complete_chore', outcome: 'ok', target_ids: { id: c.id }, person_id: h.ownerId })
  })

  it("a kid's key is refused where the kid's role is: reassigning a chore to someone else", async () => {
    const key = await h.mintKey(wally.token, 'wally-agent', ['chores:read', 'chores:write'])
    const c = await findOne(keyed(key), 'find_chores', 'walk the dog', 'reassign')
    const res = await h.tool(keyed(key), 'reassign_chore', { id: c.id, personId: kelly.id })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/parent/i)
    const audit = await lastAudit()
    expect(audit).toMatchObject({ tool: 'reassign_chore', outcome: 'denied', person_id: wally.id, target_ids: { id: c.id, personId: kelly.id } })
    expect(audit.api_key_id).not.toBeNull()

    // An adult may, by id.
    const ok = await h.tool(bearer(kevin), 'reassign_chore', { id: c.id, personId: kelly.id })
    expect(ok.isError, JSON.stringify(ok.content)).toBeFalsy()
    expect(ok.structuredContent.message).toMatch(/Kelly/)
  })

  it('a malformed or unknown id is a tool error', async () => {
    expect((await h.tool(bearer(kevin), 'complete_chore', { id: 'not-an-id' })).isError).toBe(true)
    const gone = await h.tool(bearer(kevin), 'complete_chore', { id: '11111111-2222-4333-8444-555555555555' })
    expect(gone.isError).toBe(true)
    expect(await lastAudit()).toMatchObject({ tool: 'complete_chore', outcome: 'error' })
  })
})

describe('list items', () => {
  it('complete_list_item checks an item off; delete_list_item removes one', async () => {
    const milk = await findOne(bearer(kevin), 'find_list_items', 'milk', 'complete')
    expect((await h.tool(bearer(kevin), 'complete_list_item', { id: milk.id })).isError).toBeFalsy()
    const bread = await findOne(bearer(kevin), 'find_list_items', 'bread', 'delete')
    const del = await h.tool(bearer(kevin), 'delete_list_item', { id: bread.id })
    expect(del.isError).toBeFalsy()
    const list = await h.tool(bearer(kevin), 'get_grocery_list', {})
    const items = list.structuredContent.items as Array<{ name: string; checked: boolean }>
    expect(items.find((i) => i.name === 'Milk')!.checked).toBe(true)
    expect(items.find((i) => i.name === 'Bread')).toBeUndefined()
  })
})

describe('events', () => {
  it('reschedule_event moves an event to a new household-local time', async () => {
    const ev = await findOne(bearer(kevin), 'find_events', 'soccer', 'reschedule')
    const res = await h.tool(bearer(kevin), 'reschedule_event', { id: ev.id, time: '17:00' })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    const listed = await h.tool(bearer(kevin), 'list_events', { from: tomorrow, to: tomorrow })
    const soccer = listed.structuredContent.items.find((e: { title: string }) => e.title === 'Soccer practice')
    expect(new Date(soccer.startsAt).toISOString()).toBe(zonedToUtc(`${tomorrow}T17:00`, TZ))
  })

  it('delete_event on a recurring event cancels one occurrence and says so', async () => {
    const window = { from: tomorrow, to: addDays(tomorrow, 14) }
    const before = (await h.tool(bearer(kevin), 'list_events', window)).structuredContent.items.filter((e: { title: string }) => e.title === 'Piano lesson')
    expect(before.length).toBeGreaterThanOrEqual(2)
    const res = await h.tool(bearer(kevin), 'delete_event', { id: before[0].id })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(res.structuredContent.scope).toBe('occurrence')
    expect(res.content[1].text).toMatch(/only this occurrence/i)
    const after = (await h.tool(bearer(kevin), 'list_events', window)).structuredContent.items.filter((e: { title: string }) => e.title === 'Piano lesson')
    expect(after).toHaveLength(before.length - 1)
  })
})

describe('goals', () => {
  it('log_goal adds progress to the chosen goal', async () => {
    const g = await findOne(bearer(kevin), 'find_goals', 'reading')
    const res = await h.tool(bearer(kevin), 'log_goal', { id: g.id, amount: 30 })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    const goals = await h.tool(bearer(kevin), 'list_goals', {})
    expect(goals.structuredContent.items.find((x: { id: string }) => x.id === g.id).progress).toMatchObject({ axis: 'lifetime', done: 30 })
  })

  it("find_goals never offers a goal in a private list the caller isn't in", async () => {
    const list = json(await h.call('POST', '/api/goal-lists', kelly.token, { name: 'Mine', isPrivate: true, memberIds: [kelly.id] })).list.id
    expect((await h.call('POST', '/api/goals', kelly.token, {
      title: 'Secret savings', goalListId: list, goalType: 'count', targetValue: 3, trackingMode: 'shared_total',
    })).statusCode).toBe(201)
    const kev = await h.tool(bearer(kevin), 'find_goals', { description: 'secret savings' })
    expect(kev.structuredContent.candidates).toEqual([])
    const kel = await h.tool(bearer(kelly.token), 'find_goals', { description: 'secret savings' })
    expect(kel.structuredContent.candidates[0].title).toBe('Secret savings')
  })
})

describe('rewards', () => {
  it('redeem_reward spends the caller balance; spending a sibling balance needs a parent', async () => {
    const r = await findOne(bearer(wally.token), 'find_rewards', 'ice cream')
    const own = await h.tool(bearer(wally.token), 'redeem_reward', { id: r.id })
    expect(own.isError, JSON.stringify(own.content)).toBeFalsy()
    const forKelly = await h.tool(bearer(wally.token), 'redeem_reward', { id: r.id, personId: kelly.id })
    expect(forKelly.isError).toBe(true)
    expect(await lastAudit()).toMatchObject({ tool: 'redeem_reward', outcome: 'denied', person_id: wally.id })
    const balances = await h.tool(bearer(kevin), 'get_reward_balances', {})
    const stars = (id: string) => balances.structuredContent.people.find((p: { personId: string }) => p.personId === id).balances[0].balance
    expect(stars(wally.id)).toBe(15)
    expect(stars(kelly.id)).toBe(20)
  })
})

describe('create_chore', () => {
  it('creates a chore through the same path as POST /api/chores', async () => {
    const res = await h.tool(bearer(kevin), 'create_chore', { title: 'Water the plants', personId: wally.id, rewardAmount: 2 })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    const id = res.structuredContent.chore.id
    expect(await lastAudit()).toMatchObject({ tool: 'create_chore', outcome: 'ok', target_ids: { personId: wally.id, created: id } })
    const listed = await h.tool(bearer(kevin), 'list_chores', { personId: wally.id })
    expect(listed.structuredContent.items.map((i: { title: string }) => i.title)).toContain('Water the plants')
  })

  it('a kid may add a chore for themselves but not for someone else', async () => {
    expect((await h.tool(bearer(wally.token), 'create_chore', { title: 'Tidy my room' })).isError).toBeFalsy()
    const res = await h.tool(bearer(wally.token), 'create_chore', { title: 'Mow the lawn', personId: kelly.id })
    expect(res.isError).toBe(true)
    expect(await lastAudit()).toMatchObject({ tool: 'create_chore', outcome: 'denied', person_id: wally.id })
  })

  it('validates its arguments', async () => {
    expect((await h.tool(bearer(kevin), 'create_chore', {})).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'create_chore', { title: 'x', dueOn: '2026-02-31' })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'create_chore', { title: 'x', rewardAmount: -1 })).isError).toBe(true)
  })
})

describe('add_list_item', () => {
  it('adds to the grocery list by default and to any list by id', async () => {
    const res = await h.tool(bearer(kevin), 'add_list_item', { name: 'Eggs', quantity: '12' })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(await lastAudit()).toMatchObject({ tool: 'add_list_item', outcome: 'ok', target_ids: { created: res.structuredContent.item.id } })
    const grocery = await h.tool(bearer(kevin), 'get_grocery_list', {})
    expect(grocery.structuredContent.items.find((i: { name: string }) => i.name === 'Eggs')).toMatchObject({ quantity: '12' })

    const camping = json(await h.call('POST', '/api/lists', kevin, { name: 'Camping' })).list.id
    const tent = await h.tool(bearer(kevin), 'add_list_item', { listId: camping, name: 'Tent', assignedTo: kelly.id })
    expect(tent.isError, JSON.stringify(tent.content)).toBeFalsy()
    const lists = await h.tool(bearer(kevin), 'list_lists', { listId: camping })
    expect(lists.structuredContent.list.items).toEqual([expect.objectContaining({ name: 'Tent', assignee: { id: kelly.id, name: 'Kelly' } })])
  })

  it('refuses an unknown list, an empty name and a bad priority', async () => {
    expect((await h.tool(bearer(kevin), 'add_list_item', { listId: '11111111-2222-4333-8444-555555555555', name: 'X' })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'add_list_item', { name: ' ' })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'add_list_item', { name: 'X', priority: 9 })).isError).toBe(true)
  })
})

describe('add_event', () => {
  it('reads a time without an offset as household-local, like the app does', async () => {
    const day = addDays(today, 3)
    const res = await h.tool(bearer(kevin), 'add_event', { title: 'Dentist', startsAt: `${day}T18:30`, endsAt: `${day}T19:15`, personId: kelly.id })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(await lastAudit()).toMatchObject({ tool: 'add_event', outcome: 'ok', target_ids: { personId: kelly.id, created: res.structuredContent.event.id } })
    const listed = await h.tool(bearer(kevin), 'list_events', { from: day, to: day })
    const ev = listed.structuredContent.items.find((e: { title: string }) => e.title === 'Dentist')
    expect(new Date(ev.startsAt).toISOString()).toBe(zonedToUtc(`${day}T18:30`, TZ))
    expect(ev.person).toEqual({ id: kelly.id, name: 'Kelly' })
  })

  it('an all-day event takes dates, endsAt being its last day', async () => {
    const first = addDays(today, 4)
    const last = addDays(first, 2)
    const res = await h.tool(bearer(kevin), 'add_event', { title: 'Camping trip', startsAt: first, endsAt: last, allDay: true })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(res.structuredContent.event.allDay).toBe(true)
    const on = async (day: string) =>
      (await h.tool(bearer(kevin), 'list_events', { from: day, to: day })).structuredContent.items.some((e: { title: string }) => e.title === 'Camping trip')
    expect(await on(addDays(first, -1))).toBe(false)
    expect(await on(first)).toBe(true)
    expect(await on(last)).toBe(true)
    expect(await on(addDays(last, 1))).toBe(false)
  })

  it('refuses an end before the start, a bad time and a bad rrule', async () => {
    const day = addDays(today, 5)
    expect((await h.tool(bearer(kevin), 'add_event', { title: 'X', startsAt: `${day}T10:00`, endsAt: `${day}T09:00` })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'add_event', { title: 'X', startsAt: 'soon' })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'add_event', { title: 'X', startsAt: `${day}T10:00`, rrule: 'NOT A RULE' })).isError).toBe(true)
  })
})

describe('plan_meal', () => {
  it('plans a recipe into a slot and the week shows it, mirrored onto the calendar', async () => {
    const recipe = json(await h.call('POST', '/api/recipes', kevin, { title: 'Lasagna' })).recipe.id
    const day = addDays(today, 2)
    const res = await h.tool(bearer(kevin), 'plan_meal', { date: day, mealType: 'dinner', recipeId: recipe, cookPersonId: kelly.id })
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
    expect(await lastAudit()).toMatchObject({ tool: 'plan_meal', outcome: 'ok', target_ids: { recipeId: recipe, cookPersonId: kelly.id } })
    const plan = await h.tool(bearer(kevin), 'get_meal_plan', { week: day })
    expect(plan.structuredContent.entries).toContainEqual(expect.objectContaining({ date: day, mealType: 'dinner', title: 'Lasagna', cook: { id: kelly.id, name: 'Kelly' } }))
    const events = await h.tool(bearer(kevin), 'list_events', { from: day, to: day })
    expect(events.structuredContent.items.map((e: { title: string }) => e.title).join(' ')).toMatch(/Lasagna/)
  })

  it('takes a free-text title for a meal with no recipe, and validates the slot', async () => {
    const day = addDays(today, 2)
    expect((await h.tool(bearer(kevin), 'plan_meal', { date: day, mealType: 'lunch', title: 'Leftovers' })).isError).toBeFalsy()
    expect((await h.tool(bearer(kevin), 'plan_meal', { date: day, mealType: 'brunch', title: 'X' })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'plan_meal', { date: day, mealType: 'lunch' })).isError).toBe(true)
  })
})
