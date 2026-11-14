// The /mcp read tools, driven through real JSON-RPC against a throwaway Postgres. Each
// read reuses its module's list function, so visibility, soft-deletes and week keys
// follow the same rules the app's own screens do.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startMcpHarness, bearer, keyed, json, type McpHarness } from './helpers/mcp'
import { localYmd, zonedToUtc } from '../src/modules/capture/tz'

const TZ = 'America/Chicago'
let h: McpHarness
let kevin = ''
let kelly = { id: '', token: '' }
let wally = { id: '', token: '' }
let today = ''

const names = (items: Array<{ name?: string; title?: string }>) => items.map((i) => i.name ?? i.title)

beforeAll(async () => {
  h = await startMcpHarness()
  kevin = h.owner
  kelly = await h.addMember('Kelly', 'adult')
  wally = await h.addMember('Wally', 'kid')
  today = localYmd(new Date(), TZ)

  const ev = await h.call('POST', '/api/events', kevin, { title: 'Soccer practice', startsAt: zonedToUtc(`${today}T12:00`, TZ) })
  expect(ev.statusCode).toBe(201)
  // A personal event on Kelly's own calendar: only she may see it.
  await h.sql(
    `insert into events (household_id, title, starts_at, timezone, visibility, owner_person_id, origin, sync_state)
     values ($1, 'Kelly dentist', $2, 'America/Chicago', 'personal', $3, 'manual', 'local_only')`,
    [h.householdId, zonedToUtc(`${today}T09:00`, TZ), kelly.id]
  )

  expect((await h.call('POST', '/api/chores', kevin, { title: 'Feed the cat', personId: wally.id })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/chores', kevin, { title: 'Take out trash', personId: kelly.id })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/lists/grocery/items', kevin, { name: 'Milk', quantity: '1 gal' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/meals/plan', kevin, { date: today, mealType: 'dinner', title: 'Tacos' })).statusCode).toBe(200)
  expect((await h.call('POST', '/api/recipes', kevin, { title: 'Chicken Tacos', tags: ['mexican'] })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/recipes', kevin, { title: 'Fish Tacos' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/recipes', kevin, { title: 'Pancakes' })).statusCode).toBe(201)
  expect((await h.call('POST', `/api/persons/${wally.id}/award`, kevin, { amount: 10 })).statusCode).toBe(201)
})

afterAll(async () => {
  await h?.close()
})

describe('tools/list', () => {
  it('a user session sees every read tool, each marked read-only', async () => {
    const tools = json(await h.rpc(bearer(kevin), 'tools/list')).result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
    const reads = ['get_today', 'list_events', 'list_chores', 'get_grocery_list', 'list_lists', 'get_meal_plan', 'list_goals', 'get_reward_balances', 'list_family', 'search_recipes']
    for (const name of reads) {
      const t = tools.find((x) => x.name === name)
      expect(t, name).toBeDefined()
      expect(t!.annotations?.readOnlyHint, name).toBe(true)
    }
  })
})

describe('list_events', () => {
  it('returns events in range, and a personal event only to its owner', async () => {
    const mine = await h.tool(bearer(kevin), 'list_events', { from: today, to: today })
    expect(mine.isError).toBeFalsy()
    // Planned meals mirror onto the calendar too, so look for ours by name.
    expect(names(mine.structuredContent.items)).toContain('Soccer practice')
    expect(names(mine.structuredContent.items)).not.toContain('Kelly dentist')
    expect(mine.structuredContent.items.find((e: { title: string }) => e.title === 'Soccer practice')).toMatchObject({ allDay: false, recurring: false })

    const hers = await h.tool(bearer(kelly.token), 'list_events', { from: today, to: today })
    expect(names(hers.structuredContent.items)).toEqual(expect.arrayContaining(['Kelly dentist', 'Soccer practice']))
  })

  it('refuses bad or oversized ranges as a tool error', async () => {
    expect((await h.tool(bearer(kevin), 'list_events', { from: 'nope', to: today })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'list_events', { from: '2026-01-01', to: '2026-12-31' })).isError).toBe(true)
    expect((await h.tool(bearer(kevin), 'list_events', { from: '2026-02-10', to: '2026-02-01' })).isError).toBe(true)
  })
})

describe('list_chores', () => {
  it("lists today's chores, filtered by person and status", async () => {
    const all = await h.tool(bearer(kevin), 'list_chores', {})
    expect(all.structuredContent.date).toBe(today)
    expect(names(all.structuredContent.items).sort()).toEqual(['Feed the cat', 'Take out trash'])

    const his = await h.tool(bearer(kevin), 'list_chores', { personId: wally.id, status: 'pending' })
    expect(his.structuredContent.items).toHaveLength(1)
    expect(his.structuredContent.items[0]).toMatchObject({ title: 'Feed the cat', status: 'pending', person: { id: wally.id, name: 'Wally' } })

    expect((await h.tool(bearer(kevin), 'list_chores', { status: 'done' })).structuredContent.items).toEqual([])
  })
})

describe('lists', () => {
  it("get_grocery_list returns this household week's list, keyed by the server's week start", async () => {
    const res = await h.tool(bearer(kevin), 'get_grocery_list', {})
    const { weekStart, items } = res.structuredContent
    // Households default to a Sunday week start.
    expect(new Date(`${weekStart}T00:00:00Z`).getUTCDay()).toBe(0)
    expect(items.find((i: { name: string }) => i.name === 'Milk')).toMatchObject({ quantity: '1 gal', checked: false })
  })

  it('list_lists names the grocery list with its id', async () => {
    const res = await h.tool(bearer(kevin), 'list_lists', {})
    expect(res.structuredContent.items.some((l: { listType: string }) => l.listType === 'grocery')).toBe(true)
  })
})

describe('get_meal_plan', () => {
  it('snaps any date to the household week and returns its entries', async () => {
    const res = await h.tool(bearer(kevin), 'get_meal_plan', { week: today })
    const { weekStart, entries } = res.structuredContent
    expect(new Date(`${weekStart}T00:00:00Z`).getUTCDay()).toBe(0)
    expect(weekStart <= today).toBe(true)
    expect(entries).toContainEqual(expect.objectContaining({ date: today, mealType: 'dinner', title: 'Tacos' }))
  })
})

describe('list_goals', () => {
  it("shows a habit on this period's axis and hides goals in a private list the caller isn't in", async () => {
    const habit = json(await h.call('POST', '/api/goals', kevin, {
      title: 'Read every day', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      trackingMode: 'shared_total', participantIds: [h.ownerId],
    })).goal.id
    expect((await h.call('POST', `/api/goals/${habit}/log`, kevin, { amount: 1 })).statusCode).toBeLessThan(300)
    const secret = json(await h.call('POST', '/api/goal-lists', kelly.token, { name: 'Just me', isPrivate: true, memberIds: [kelly.id] })).list.id
    expect((await h.call('POST', '/api/goals', kelly.token, {
      title: 'Surprise party', goalListId: secret, goalType: 'count', targetValue: 3, trackingMode: 'shared_total',
    })).statusCode).toBe(201)

    const kev = await h.tool(bearer(kevin), 'list_goals', {})
    expect(names(kev.structuredContent.items)).not.toContain('Surprise party')
    const read = kev.structuredContent.items.find((g: { title: string }) => g.title === 'Read every day')
    expect(read.progress).toEqual({ axis: 'period', period: 'week', done: 1, target: 5 })

    const kel = await h.tool(bearer(kelly.token), 'list_goals', {})
    expect(names(kel.structuredContent.items)).toContain('Surprise party')
  })
})

describe('get_reward_balances and list_family', () => {
  it('reports each member balance', async () => {
    const res = await h.tool(bearer(kevin), 'get_reward_balances', {})
    const w = res.structuredContent.people.find((p: { personId: string }) => p.personId === wally.id)
    expect(w.balances).toContainEqual({ currency: 'stars', balance: 10 })
  })

  it('lists members without any account details', async () => {
    const res = await h.tool(bearer(kevin), 'list_family', {})
    expect(names(res.structuredContent.items).sort()).toEqual(['Kelly', 'Kevin', 'Wally'])
    expect(JSON.stringify(res.structuredContent)).not.toMatch(/@example\.com/)
  })
})

describe('search_recipes', () => {
  it('ranks recipes by the query and caps the result', async () => {
    const res = await h.tool(bearer(kevin), 'search_recipes', { query: 'tacos' })
    expect(names(res.structuredContent.items).sort()).toEqual(['Chicken Tacos', 'Fish Tacos'])
    const one = await h.tool(bearer(kevin), 'search_recipes', { query: 'tacos', limit: 1 })
    expect(one.structuredContent).toMatchObject({ total: 2, truncated: true })
    expect(one.structuredContent.items).toHaveLength(1)
  })

  it('requires a query', async () => {
    expect((await h.tool(bearer(kevin), 'search_recipes', {})).isError).toBe(true)
  })
})

describe('get_today — a section shows only when the grant covers its scope', () => {
  it('family:read alone returns the date and no sections', async () => {
    const key = await h.mintKey(kevin, 'today-family', ['family:read'])
    const res = await h.tool(keyed(key), 'get_today', {})
    expect(res.structuredContent.date).toBe(today)
    expect(res.structuredContent.events).toBeUndefined()
    expect(res.structuredContent.chores).toBeUndefined()
    expect(res.structuredContent.meals).toBeUndefined()
    expect(res.structuredContent.omitted).toEqual(expect.arrayContaining(['events', 'chores', 'meals', 'grocery']))
  })

  it('adding calendar:read adds the events section only', async () => {
    const key = await h.mintKey(kevin, 'today-cal', ['family:read', 'calendar:read'])
    const res = await h.tool(keyed(key), 'get_today', {})
    expect(names(res.structuredContent.events)).toContain('Soccer practice')
    expect(res.structuredContent.chores).toBeUndefined()
  })

  it('a user session gets every section', async () => {
    const res = await h.tool(bearer(kevin), 'get_today', {})
    const t = res.structuredContent
    expect(names(t.events)).toContain('Soccer practice')
    expect(names(t.events)).not.toContain('Kelly dentist')
    expect(t.chores).toHaveLength(2)
    expect(t.meals).toContainEqual(expect.objectContaining({ mealType: 'dinner', title: 'Tacos' }))
    expect(t.grocery).toMatchObject({ open: 1 })
    expect(t.omitted).toEqual([])
  })

  it('a section whose module is off is omitted too', async () => {
    await h.sql(
      `update households set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}', coalesce(settings->'modules', '{}'::jsonb) || '{"chores": false}'::jsonb) where id = $1`,
      [h.householdId]
    )
    try {
      const res = await h.tool(bearer(kevin), 'get_today', {})
      expect(res.structuredContent.chores).toBeUndefined()
      expect(res.structuredContent.omitted).toContain('chores')
      const listed = json(await h.rpc(bearer(kevin), 'tools/list')).result.tools.map((t: { name: string }) => t.name)
      expect(listed).not.toContain('list_chores')
      expect(listed).not.toContain('get_reward_balances')
    } finally {
      await h.sql(`update households set settings = settings #- '{modules,chores}' where id = $1`, [h.householdId])
    }
  })
})
