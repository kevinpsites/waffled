// whats_new(since): the change feed a polling agent reads (docs/product/mcp-plan.md §6 tier
// A). Derived from existing timestamps, and filtered through each module's own read rules,
// so a private event or a goal in someone else's private list never shows up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startMcpHarness, bearer, keyed, json, type McpHarness } from './helpers/mcp'
import { localYmd, zonedToUtc } from '../src/modules/capture/tz'

const TZ = 'America/Chicago'
let h: McpHarness
let kevin = ''
let kelly = { id: '', token: '' }
let wally = { id: '', token: '' }
let today = ''
let since = ''
let settleMs = 0

interface Item {
  kind: string
  at: string
  who: { id: string; name: string | null } | null
  title: string
  ids: Record<string, string>
  [k: string]: unknown
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

async function whatsNew(headers: Record<string, string>, args: Record<string, unknown> = { since }) {
  const res = await h.tool(headers, 'whats_new', args)
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy()
  return res.structuredContent as { until: string; items: Item[]; truncated: boolean; nextSince?: string; partialAt?: string; omitted: string[]; sections: string[] }
}
const titled = (items: Item[], kind: string) => items.filter((i) => i.kind === kind).map((i) => i.title)
// whats_new lags real time, so a change is only reported once it is older than the lag.
const settle = () => new Promise((r) => setTimeout(r, settleMs + 500))

async function find(headers: Record<string, string>, tool: string, description: string, verb?: string) {
  const res = await h.tool(headers, tool, { description, ...(verb ? { verb } : {}) })
  expect(res.structuredContent.candidates.length, `${tool} ${description}`).toBeGreaterThan(0)
  return res.structuredContent.candidates[0].id as string
}

beforeAll(async () => {
  h = await startMcpHarness()
  settleMs = (await import('../src/modules/mcp/tools/whats-new')).SETTLE_MS
  kevin = h.owner
  kelly = await h.addMember('Kelly', 'adult')
  wally = await h.addMember('Wally', 'kid')
  today = localYmd(new Date(), TZ)
  const at = (ymd: string, hm: string) => zonedToUtc(`${ymd}T${hm}`, TZ)

  // Old rows: made three days back, so a one-day `since` must not report them…
  const old = json(await h.call('POST', '/api/events', kevin, { title: 'Old dentist', startsAt: at(addDays(today, 2), '09:00') })).event.id
  const untouched = json(await h.call('POST', '/api/events', kevin, { title: 'Old untouched', startsAt: at(addDays(today, 2), '11:00') })).event.id
  // set_updated_at would stamp the backdate itself as a change, so hold it off for this one.
  await h.sql(`alter table events disable trigger trg_events_updated`)
  await h.sql(`update events set created_at = now() - interval '3 days', updated_at = now() - interval '3 days' where id = any($1)`, [[old, untouched]])
  await h.sql(`alter table events enable trigger trg_events_updated`)
  since = ago(24 * 3600_000)
  // …unless it changed since: this one is moved now.
  expect((await h.call('PATCH', `/api/events/${old}`, kevin, { title: 'Old dentist (moved)' })).statusCode).toBe(200)

  expect((await h.call('POST', '/api/events', kevin, { title: 'Soccer practice', startsAt: at(addDays(today, 1), '15:00') })).statusCode).toBe(201)
  const doomed = json(await h.call('POST', '/api/events', kevin, { title: 'Cancelled recital', startsAt: at(addDays(today, 3), '18:00') })).event.id
  expect((await h.call('DELETE', `/api/events/${doomed}`, kevin)).statusCode).toBeLessThan(300)
  // A personal event on Kelly's own calendar: only she may see it.
  await h.sql(
    `insert into events (household_id, title, starts_at, timezone, visibility, owner_person_id, origin, sync_state)
     values ($1, 'Kelly therapy', $2, 'America/Chicago', 'personal', $3, 'manual', 'local_only')`,
    [h.householdId, at(addDays(today, 1), '10:00'), kelly.id]
  )

  expect((await h.call('POST', '/api/chores', kevin, { title: 'Feed the cat', personId: wally.id })).statusCode).toBe(201)
  const cat = await find(bearer(wally.token), 'find_chores', 'feed the cat')
  expect((await h.tool(bearer(wally.token), 'complete_chore', { id: cat })).isError).toBeFalsy()

  for (const name of ['Milk', 'Bread', 'Eggs']) expect((await h.call('POST', '/api/lists/grocery/items', kevin, { name })).statusCode).toBe(201)
  expect((await h.tool(bearer(kelly.token), 'complete_list_item', { id: await find(bearer(kelly.token), 'find_list_items', 'bread') })).isError).toBeFalsy()
  expect((await h.tool(bearer(kevin), 'delete_list_item', { id: await find(bearer(kevin), 'find_list_items', 'eggs', 'delete') })).isError).toBeFalsy()

  const reading = json(await h.call('POST', '/api/goals', kevin, { title: 'Reading minutes', goalType: 'total', unit: 'minutes', targetValue: 600, trackingMode: 'shared_total' })).goal.id
  expect((await h.call('POST', `/api/goals/${reading}/log`, kevin, { amount: 30 })).statusCode).toBeLessThan(300)
  const secret = json(await h.call('POST', '/api/goal-lists', kelly.token, { name: 'Just me', isPrivate: true, memberIds: [kelly.id] })).list.id
  const party = json(await h.call('POST', '/api/goals', kelly.token, { title: 'Surprise party', goalListId: secret, goalType: 'count', targetValue: 3, trackingMode: 'shared_total' })).goal.id
  expect((await h.call('POST', `/api/goals/${party}/log`, kelly.token, { amount: 1 })).statusCode).toBeLessThan(300)

  expect((await h.call('POST', '/api/rewards', kevin, { title: 'Ice cream night', cost: 5, requiresApproval: false })).statusCode).toBe(201)
  expect((await h.call('POST', `/api/persons/${wally.id}/award`, kevin, { amount: 20 })).statusCode).toBe(201)
  expect((await h.tool(bearer(wally.token), 'redeem_reward', { id: await find(bearer(wally.token), 'find_rewards', 'ice cream') })).isError).toBeFalsy()

  expect((await h.call('POST', '/api/meals/plan', kevin, { date: today, mealType: 'dinner', title: 'Tacos' })).statusCode).toBe(200)

  expect((await h.call('POST', '/api/events', kevin, { title: 'Piano lesson', startsAt: at(addDays(today, 1), '16:00'), rrule: 'FREQ=WEEKLY' })).statusCode).toBe(201)
  const occ = await find(bearer(kevin), 'find_events', 'piano lesson', 'delete')
  expect((await h.tool(bearer(kevin), 'delete_event', { id: occ })).structuredContent.scope).toBe('occurrence')

  // A re-sync rewrites every feed row, so updated_at is now while the event is old.
  const [school] = await h.sql<{ id: string }>(`insert into ics_feeds (household_id, url, name) values ($1, 'https://example.com/school.ics', 'School') returning id`, [h.householdId])
  await h.sql(
    `insert into events (household_id, title, starts_at, timezone, origin, origin_ref_id, google_event_id, sync_state, created_at)
     values ($1, 'School assembly', $2, 'America/Chicago', 'ics', $3, 'uid-1', 'synced', now() - interval '3 days')`,
    [h.householdId, at(addDays(today, 4), '09:00'), school.id]
  )

  // A custom list: the auto-clear sweep removes an item checked more than a day ago when
  // the list is loaded; people remove the other two.
  const camping = json(await h.call('POST', '/api/lists', kevin, { name: 'Camping' })).list.id
  const addCamp = async (name: string) => json(await h.call('POST', `/api/lists/${camping}/items`, kevin, { name })).item.id as string
  const tent = await addCamp('Tent')
  const stove = await addCamp('Stove')
  const lantern = await addCamp('Lantern')
  for (const id of [tent, lantern]) expect((await h.call('PATCH', `/api/list-items/${id}`, kevin, { checked: true })).statusCode).toBe(200)
  await h.sql(`update list_items set checked_at = now() - interval '2 days' where id = $1`, [tent])
  expect((await h.call('GET', `/api/lists/${camping}`, kevin)).statusCode).toBe(200)
  const [swept] = await h.sql<{ deleted_at: Date | null }>(`select deleted_at from list_items where id = $1`, [tent])
  expect(swept.deleted_at).not.toBeNull()
  for (const id of [stove, lantern]) expect((await h.call('DELETE', `/api/list-items/${id}`, kevin)).statusCode).toBe(204)

  await settle()
})

afterAll(async () => {
  await h?.close()
})

describe('whats_new — arguments', () => {
  it('is a read-only family:read tool', async () => {
    const tools = json(await h.rpc(bearer(kevin), 'tools/list')).result.tools
    const t = tools.find((x: { name: string }) => x.name === 'whats_new')
    expect(t.annotations.readOnlyHint).toBe(true)
    expect(t.inputSchema.required).toEqual(['since'])
  })

  it('requires since as a timestamp no more than 14 days back and not in the future', async () => {
    for (const args of [{}, { since: 'yesterday' }, { since: ago(15 * 86_400_000) }, { since: new Date(Date.now() + 3600_000).toISOString() }]) {
      const res = await h.tool(bearer(kevin), 'whats_new', args)
      expect(res.isError, JSON.stringify(args)).toBe(true)
    }
    expect((await h.tool(bearer(kevin), 'whats_new', { since: ago(13 * 86_400_000) })).isError).toBeFalsy()
  })
})

describe('whats_new — events', () => {
  it('reports added, changed and cancelled events since, and nothing older', async () => {
    const { items } = await whatsNew(bearer(kevin))
    expect(titled(items, 'event_added')).toContain('Soccer practice')
    expect(titled(items, 'event_updated')).toContain('Old dentist (moved)')
    expect(titled(items, 'event_cancelled')).toContain('Cancelled recital')
    expect(items.map((i) => i.title)).not.toContain('Old untouched')
  })

  it("never shows another member's personal event; its owner sees it", async () => {
    expect((await whatsNew(bearer(kevin))).items.map((i) => i.title)).not.toContain('Kelly therapy')
    expect(titled((await whatsNew(bearer(kelly.token))).items, 'event_added')).toContain('Kelly therapy')
  })

  it('reports one cancelled occurrence of a recurring event', async () => {
    expect(titled((await whatsNew(bearer(kevin))).items, 'occurrence_cancelled')).toContain('Piano lesson')
  })

  it('does not report a calendar-feed event as changed just because the feed was polled again', async () => {
    const titles = (await whatsNew(bearer(kevin))).items.map((i) => i.title)
    expect(titles).not.toContain('School assembly')
  })

  it('a key without calendar:read gets no events section, and says so', async () => {
    const key = await h.mintKey(kevin, 'wn-chores', ['family:read', 'chores:read'])
    const out = await whatsNew(keyed(key))
    expect(out.omitted).toContain('events')
    expect(out.sections).toEqual(['chores'])
    expect(out.items.some((i) => i.kind.startsWith('event_'))).toBe(false)
    expect(out.items.some((i) => i.kind === 'chore_completed')).toBe(true)
  })
})

describe('whats_new — chores, lists, goals, rewards, meals', () => {
  it('reports a completed chore with who did it, and a new chore', async () => {
    const { items } = await whatsNew(bearer(kevin))
    const done = items.find((i) => i.kind === 'chore_completed' && i.title === 'Feed the cat')
    expect(done?.who).toEqual({ id: wally.id, name: 'Wally' })
    expect(titled(items, 'chore_added')).toContain('Feed the cat')
  })

  it('reports list items added, checked and removed', async () => {
    const { items } = await whatsNew(bearer(kevin))
    expect(titled(items, 'list_item_added')).toEqual(expect.arrayContaining(['Milk', 'Bread', 'Eggs']))
    const bread = items.find((i) => i.kind === 'list_item_checked' && i.title === 'Bread')
    expect(bread?.who).toEqual({ id: kelly.id, name: 'Kelly' })
    expect(titled(items, 'list_item_removed')).toContain('Eggs')
  })

  it('reports what a person removed, never what the auto-clear sweep did', async () => {
    const removed = titled((await whatsNew(bearer(kevin))).items, 'list_item_removed')
    expect(removed).toEqual(expect.arrayContaining(['Stove', 'Lantern']))
    expect(removed).not.toContain('Tent')
  })

  it("reports goal progress on the goal's display axis, never from a private list the caller isn't in", async () => {
    const kev = (await whatsNew(bearer(kevin))).items
    const log = kev.find((i) => i.kind === 'goal_logged' && i.title === 'Reading minutes')
    expect(log).toMatchObject({ amount: 30, unit: 'minutes', progress: { axis: 'lifetime', done: 30, target: 600 } })
    expect(log?.who).toEqual({ id: h.ownerId, name: 'Kevin' })
    expect(kev.map((i) => i.title)).not.toContain('Surprise party')
    expect(titled((await whatsNew(bearer(kelly.token))).items, 'goal_logged')).toContain('Surprise party')
  })

  it('reports stars earned and spent', async () => {
    const { items } = await whatsNew(bearer(kevin))
    expect(items.find((i) => i.kind === 'reward_earned' && i.who?.id === wally.id)).toMatchObject({ amount: 20, currency: 'stars' })
    expect(items.find((i) => i.kind === 'reward_spent' && i.who?.id === wally.id)).toMatchObject({ amount: -5, currency: 'stars' })
  })

  it('reports a planned meal', async () => {
    const { items } = await whatsNew(bearer(kevin))
    expect(items.find((i) => i.kind === 'meal_planned' && i.title === 'Tacos')).toMatchObject({ date: today, mealType: 'dinner' })
  })

  it('lists items oldest first', async () => {
    const { items } = await whatsNew(bearer(kevin))
    const times = items.map((i) => Date.parse(i.at))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
})

describe('whats_new — cursor', () => {
  it('lags real time by a few seconds, leaving the newest changes to the next call', async () => {
    const recent = ago(60_000)
    expect((await h.call('POST', '/api/lists/grocery/items', kevin, { name: 'Fresh basil' })).statusCode).toBe(201)
    expect((await h.call('POST', '/api/events', kevin, { title: 'Fresh event', startsAt: zonedToUtc(`${addDays(today, 2)}T12:00`, TZ) })).statusCode).toBe(201)
    const first = await whatsNew(bearer(kevin), { since: recent })
    expect(first.truncated).toBe(false)
    expect(first.items.map((i) => i.title)).not.toContain('Fresh basil')
    expect(first.items.map((i) => i.title)).not.toContain('Fresh event')
    expect(Date.parse(first.until)).toBeLessThan(Date.now() - settleMs + 1000)
    await settle()
    const next = await whatsNew(bearer(kevin), { since: first.until })
    expect(titled(next.items, 'list_item_added')).toContain('Fresh basil')
    expect(titled(next.items, 'event_added')).toContain('Fresh event')
  })
})

describe('whats_new — caps', () => {
  it('cuts a long feed, says so, and hands back a since to continue from', async () => {
    const [grocery] = await h.sql<{ id: string }>(`select id from lists where household_id = $1 and list_type = 'grocery'`, [h.householdId])
    await h.sql(
      `insert into list_items (household_id, list_id, name, created_at)
       select $1, $2, 'Bulk ' || g, now() - interval '2 hours' + g * interval '1 second' from generate_series(1, 260) g`,
      [h.householdId, grocery.id]
    )
    const first = await whatsNew(bearer(kevin), { since: ago(3 * 3600_000) })
    expect(first.truncated).toBe(true)
    expect(first.items.length).toBe(200)
    expect(first.nextSince).toBe(first.items[first.items.length - 1].at)
    const rest = await whatsNew(bearer(kevin), { since: first.nextSince })
    expect(rest.items.map((i) => i.title)).toContain('Bulk 260')
    const seen = new Set(first.items.map((i) => JSON.stringify(i.ids) + i.kind))
    expect(rest.items.filter((i) => seen.has(JSON.stringify(i.ids) + i.kind))).toEqual([])
  })

  it('never splits or repeats a group of changes sharing one timestamp, so paging always moves on', async () => {
    const [grocery] = await h.sql<{ id: string }>(`select id from lists where household_id = $1 and list_type = 'grocery'`, [h.householdId])
    // One statement: every row gets the same now(), as a bulk import would.
    await h.sql(
      `insert into list_items (household_id, list_id, name, created_at)
       select $1, $2, 'Same ' || g, now() - interval '5 hours' from generate_series(1, 250) g`,
      [h.householdId, grocery.id]
    )
    const first = await whatsNew(bearer(kevin), { since: ago(6 * 3600_000) })
    expect(first.truncated).toBe(true)
    // More rows share that instant than fit on a page: it says so rather than loop on them.
    expect(first.partialAt).toBe(first.nextSince)
    const rest = await whatsNew(bearer(kevin), { since: first.nextSince })
    const seen = new Set(first.items.map((i) => JSON.stringify(i.ids) + i.kind))
    expect(rest.items.filter((i) => seen.has(JSON.stringify(i.ids) + i.kind))).toEqual([])
    expect(rest.items.some((i) => i.title.startsWith('Bulk '))).toBe(true)
    expect(rest.nextSince ?? '').not.toBe(first.nextSince)
  })
})
