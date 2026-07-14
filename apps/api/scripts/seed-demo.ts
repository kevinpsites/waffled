// Seed a rich demo household ("The Seinfelds") for screenshots / docs / app-store.
// DEV / SEED TOOL ONLY. Two phases so recipes can be copied in between.
//
// This file is an esbuild entrypoint (see esbuild.config.mjs), so it also ships in
// the runtime image as `dist/seed-demo.js`. Prefer running it IN the api container —
// no host Node/tsx, no node_modules, and DATABASE_URL is already the stack's DB:
//
//   docker compose exec api node dist/seed-demo.js base
//   # …copy recipes into the DB (see ./scripts, or the pg_dump|sed|psql step)…
//   docker compose exec api node dist/seed-demo.js meals
//
// Or run it on the host against any stack's DATABASE_URL (like import-recipes.ts):
//
//   cd apps/api
//   DATABASE_URL=postgres://waffled:<pw>@localhost:5532/waffled npx tsx scripts/seed-demo.ts base
//   DATABASE_URL=… npx tsx scripts/seed-demo.ts meals
//
// `base`  — household, 4 people (Jerry+Kramer adults, George+Elaine kids), modules,
//           currencies, rewards + kid jars, chores + star ledger, goals + logs,
//           lists, pantry, photos, calendar events + countdowns. Writes an ids file.
// `meals` — meal plan for the week from the (already-copied) recipes + favorites/cooked.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { query, closePool } from '../src/platform/db'
import { provisionHousehold } from '../src/modules/households/households'
import { hashPassword } from '../src/modules/auth/auth'

const TZ = 'America/New_York'
const IDS_FILE = join(tmpdir(), 'waffled-seed-ids.json')

type Ids = { household: string; jerry: string; kramer: string; george: string; elaine: string }

async function one<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
  const r = await query<T>(sql, params)
  return r.rows[0]
}

// Insert a person (non-owner) and return its id.
async function addPerson(hh: string, p: {
  name: string; memberType: 'adult' | 'teen' | 'kid'; emoji: string; color: string;
  rewardStyle?: string; birthday?: string; sort: number
}): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin, avatar_type, avatar_emoji,
       color_hex, reward_style, birthday, show_on_kiosk, sort_order)
     values ($1,$2,$3,false,'emoji',$4,$5,$6,$7,true,$8) returning id`,
    [hh, p.name, p.memberType, p.emoji, p.color, p.rewardStyle ?? 'stars', p.birthday ?? null, p.sort]
  )
  return row.id
}

// A timed event at local wall-clock `HH:MM` on current_date + dayOffset (household TZ).
async function timedEvent(hh: string, o: {
  title: string; emoji?: string; day: number; time: string; durMin?: number; person: string | null
}) {
  await query(
    `insert into events (household_id, title, starts_at, ends_at, all_day, timezone, person_id,
       origin, sync_state, status)
     values ($1,$2,
       ((current_date + $3::int)::timestamp + $4::time) at time zone $5,
       ((current_date + $3::int)::timestamp + $4::time + ($6 || ' minutes')::interval) at time zone $5,
       false,$5,$7,'manual','local_only','confirmed')`,
    [hh, o.emoji ? `${o.emoji} ${o.title}` : o.title, o.day, o.time, TZ, String(o.durMin ?? 60), o.person]
  )
}

async function allDayEvent(hh: string, o: {
  title: string; emoji?: string; day: number; person: string | null; countdown?: boolean
}) {
  await query(
    `insert into events (household_id, title, starts_at, all_day, timezone, person_id,
       origin, sync_state, status, is_countdown)
     values ($1,$2,(current_date + $3::int)::timestamp at time zone $4,true,$4,$5,
       'manual','local_only','confirmed',$6)`,
    [hh, o.emoji ? `${o.emoji} ${o.title}` : o.title, o.day, TZ, o.person, o.countdown ?? false]
  )
}

// Goals live in lists; a list's members make it individual (1) or a group (many).
// The iOS Goals page fetches goals PER LIST, so a list-less goal is invisible on iPad.
// Model: one "Family Goals" group (all 4 members, 2 shared goals) + one individual list
// per person (1 member, their own goal). Idempotent — clears existing goal data first.
async function seedGoals(ids: Ids) {
  const { household: hh, jerry, kramer, george, elaine } = ids
  for (const t of ['goal_logs', 'goal_participants', 'goals', 'goal_list_members', 'goal_lists'])
    await query(`delete from ${t} where household_id=$1`, [hh])

  async function makeList(name: string, emoji: string, color: string, members: string[]): Promise<string> {
    const l = await one<{ id: string }>(
      `insert into goal_lists (household_id, name, emoji, color_hex) values ($1,$2,$3,$4) returning id`, [hh, name, emoji, color])
    for (const p of members)
      await query(`insert into goal_list_members (household_id, goal_list_id, person_id) values ($1,$2,$3)`, [hh, l.id, p])
    return l.id
  }
  const family = await makeList('Family Goals', '🎯', '#6E56CF', [jerry, kramer, george, elaine])
  const lists: Record<string, string> = {
    [jerry]: await makeList('Jerry', '😎', '#4F7FE0', [jerry]),
    [kramer]: await makeList('Kramer', '🤪', '#E8913A', [kramer]),
    [george]: await makeList('George', '😬', '#E0574F', [george]),
    [elaine]: await makeList('Elaine', '💁‍♀️', '#35B0A7', [elaine]),
  }

  type G = { list: string; title: string; emoji: string; cat: string; type: string; period?: string; target: number; people: string[]; featured?: boolean }
  const goals: G[] = [
    // Family group — 2 shared goals (everyone)
    { list: family, title: 'Drink 8 glasses of water', emoji: '💧', cat: 'physical', type: 'count', target: 12, people: [jerry, kramer, george, elaine], featured: true },
    { list: family, title: 'Family walk after dinner', emoji: '🚶', cat: 'social', type: 'habit', period: 'day', target: 1, people: [jerry, kramer, george, elaine] },
    // Individuals — one each (own list)
    { list: lists[jerry], title: 'Run 3× a week', emoji: '🏃', cat: 'physical', type: 'habit', period: 'week', target: 3, people: [jerry] },
    { list: lists[kramer], title: 'Meditate 10 minutes', emoji: '🧘', cat: 'spiritual', type: 'habit', period: 'day', target: 1, people: [kramer] },
    { list: lists[george], title: 'Read every day', emoji: '📚', cat: 'intellectual', type: 'habit', period: 'day', target: 1, people: [george] },
    { list: lists[elaine], title: 'Practice piano', emoji: '🎹', cat: 'creative', type: 'habit', period: 'day', target: 1, people: [elaine] },
  ]
  for (const g of goals) {
    const shared = g.people.length > 1
    const isHabit = g.type === 'habit'
    const row = await one<{ id: string }>(
      `insert into goals (household_id, goal_list_id, title, emoji, category, goal_type, tracking_mode,
         log_method, is_active, is_featured, habit_period, habit_target_per_period, target_value)
       values ($1,$2,$3,$4,$5,$6,$7,'quick_log',true,$8,$9,$10,$11) returning id`,
      [hh, g.list, g.title, g.emoji, g.cat, g.type, shared ? 'shared_total' : 'each_tracks',
       g.featured ?? false, isHabit ? g.period : null, isHabit ? g.target : null, isHabit ? null : g.target])
    for (const p of g.people)
      await query(`insert into goal_participants (household_id, goal_id, person_id) values ($1,$2,$3)`, [hh, row.id, p])
    // 3 recent days of logs → streaks + full/partial progress rings
    for (const d of [0, 1, 2])
      for (const p of g.people)
        await query(
          `insert into goal_logs (household_id, goal_id, person_id, amount, source, logged_at)
           values ($1,$2,$3,1,'quick_log', now() - ($4 || ' days')::interval)`, [hh, row.id, p, String(d)])
  }
}

async function seedBase() {
  const exists = await query(`select 1 from households where name = 'The Seinfelds' and deleted_at is null`)
  if (exists.rowCount) throw new Error('A "The Seinfelds" household already exists — run ./waffled-demo nuke first for a clean seed.')

  // ── Household + Jerry (owner/admin, with a login) ────────────────────────────
  const { household } = await provisionHousehold({
    sub: `password:${randomUUID()}`,
    provider: 'password',
    email: 'jerry@seinfeld.demo',
    emailVerified: true,
    householdName: 'The Seinfelds',
    timezone: TZ,
    person: { name: 'Jerry', avatarEmoji: '😎', colorHex: '#4F7FE0' },
    credential: { email: 'jerry@seinfeld.demo', passwordHash: hashPassword('seinfeld123') },
  })
  const hh = household.id
  const jerry = (await one<{ id: string }>(`select id from persons where household_id=$1 and name='Jerry'`, [hh])).id

  // ── The rest of the family ───────────────────────────────────────────────────
  const kramer = await addPerson(hh, { name: 'Kramer', memberType: 'adult', emoji: '🤪', color: '#E8913A', sort: 1 })
  const george = await addPerson(hh, { name: 'George', memberType: 'kid', emoji: '😬', color: '#E0574F', rewardStyle: 'jar', birthday: '2015-04-12', sort: 2 })
  const elaine = await addPerson(hh, { name: 'Elaine', memberType: 'kid', emoji: '💁‍♀️', color: '#35B0A7', rewardStyle: 'stars', birthday: '2017-09-23', sort: 3 })
  const ids: Ids = { household: hh, jerry, kramer, george, elaine }

  // ── Enable every module + rewards ────────────────────────────────────────────
  await query(
    `update households set week_start='sunday', settings = settings
       || '{"modules":{"chores":true,"goals":true,"meals":true,"lists":true,"pantry":true,"familyNight":true}}'::jsonb
       || jsonb_build_object('chores', jsonb_build_object('rewards', true))
     where id=$1`, [hh])

  // ── Currency (household created post-backfill, so seed the default) ───────────
  await query(
    `insert into currencies (household_id, key, label, symbol, color, is_default, spendable, sort_order)
     values ($1,'stars','Stars','⭐','#F3A93B',true,true,0)`, [hh])

  // ── Rewards catalog ──────────────────────────────────────────────────────────
  const rewards = [
    { title: 'Ice cream sundae', emoji: '🍨', cost: 30 },
    { title: 'Extra hour of screen time', emoji: '📱', cost: 20 },
    { title: 'Pick Friday night dinner', emoji: '🍕', cost: 40 },
    { title: 'Movie night out', emoji: '🎬', cost: 60 },
    { title: 'New video game', emoji: '🎮', cost: 80 },
    { title: 'Sleepover with a friend', emoji: '🏕️', cost: 100 },
  ]
  const rewardId: Record<string, string> = {}
  for (const [i, r] of rewards.entries()) {
    const row = await one<{ id: string }>(
      `insert into rewards (household_id, title, emoji, cost, currency, sort_order)
       values ($1,$2,$3,$4,'stars',$5) returning id`, [hh, r.title, r.emoji, r.cost, i])
    rewardId[r.title] = row.id
  }
  // Kids saving toward a reward (drives the "jar")
  await query(`update persons set saving_toward_reward_id=$1 where id=$2`, [rewardId['New video game'], george])
  await query(`update persons set saving_toward_reward_id=$1 where id=$2`, [rewardId['Movie night out'], elaine])

  // ── Chores + instances ───────────────────────────────────────────────────────
  const chores = [
    { title: 'Make your bed', emoji: '🛏️', person: george, amount: 3 },
    { title: 'Take out the trash', emoji: '🗑️', person: george, amount: 8, approval: true },
    { title: 'Walk to the newsstand', emoji: '📰', person: george, amount: 5 },
    { title: 'Set the table', emoji: '🍽️', person: elaine, amount: 3 },
    { title: 'Feed the goldfish', emoji: '🐠', person: elaine, amount: 3 },
    { title: 'Tidy your room', emoji: '🧹', person: elaine, amount: 6, photo: true },
    { title: 'Load the dishwasher', emoji: '🍴', person: null, amount: 5 }, // up for grabs
  ]
  const choreId: Record<string, string> = {}
  for (const c of chores) {
    const row = await one<{ id: string }>(
      `insert into chores (household_id, title, emoji, person_id, reward_currency, reward_amount,
         requires_approval, requires_photo, is_active, show_on_kiosk)
       values ($1,$2,$3,$4,'stars',$5,$6,$7,true,true) returning id`,
      [hh, c.title, c.emoji, c.person, c.amount, c.approval ?? false, c.photo ?? false])
    choreId[c.title] = row.id
  }
  // Instances: a mix of done (past), pending (today/tomorrow), and one awaiting approval.
  async function instance(chore: string, person: string, o: {
    dayOffset: number; status: 'pending' | 'done' | 'awaiting'; amount: number; approval?: 'approved' | 'pending'
  }): Promise<string> {
    const done = o.status === 'done'
    const row = await one<{ id: string }>(
      `insert into chore_instances (household_id, chore_id, person_id, due_on, status,
         completed_by, completed_at, reward_currency, reward_amount, awarded, approval_status)
       values ($1,$2,$3,current_date + $4::int,$5,$6,$7,'stars',$8,$9,$10) returning id`,
      [hh, choreId[chore], person, o.dayOffset, o.status,
       done ? person : null,
       done ? new Date() : null,
       o.amount, done, o.approval ?? null])
    return row.id
  }
  // George: two done, one pending today, one awaiting approval
  const gDone1 = await instance('Make your bed', george, { dayOffset: -1, status: 'done', amount: 3 })
  const gDone2 = await instance('Walk to the newsstand', george, { dayOffset: -1, status: 'done', amount: 5 })
  await instance('Make your bed', george, { dayOffset: 0, status: 'pending', amount: 3 })
  await instance('Take out the trash', george, { dayOffset: 0, status: 'awaiting', amount: 8, approval: 'pending' })
  // Elaine: two done, one pending
  const eDone1 = await instance('Set the table', elaine, { dayOffset: -1, status: 'done', amount: 3 })
  const eDone2 = await instance('Feed the goldfish', elaine, { dayOffset: -1, status: 'done', amount: 3 })
  await instance('Tidy your room', elaine, { dayOffset: 0, status: 'pending', amount: 6 })

  // ── Star ledger (balances are SUM(ledger); jars/overview compute the rest) ────
  // George → 65 ⭐ (81% of the 80⭐ game), Elaine → 42 ⭐ (70% of the 60⭐ movie night).
  async function earn(person: string, amount: number, refId: string | null, daysAgo: number) {
    await query(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by, created_at)
       values ($1,$2,'stars',$3,'chore_completed','chore_instance',$4,$5, now() - ($6 || ' days')::interval)`,
      [hh, person, amount, refId, person, String(daysAgo)])
  }
  const gEarns = [[8, 6], [5, 6], [8, 5], [5, 4], [8, 3], [5, 2], [8, 1], [3, gDone1 ? 1 : 1], [5, 1], [10, 0]]
  await earn(george, 3, gDone1, 1); await earn(george, 5, gDone2, 1)
  for (const [amt, d] of [[8, 6], [5, 5], [8, 4], [5, 3], [8, 2], [10, 1], [5, 0]] as const) await earn(george, amt, null, d)
  await earn(elaine, 3, eDone1, 1); await earn(elaine, 3, eDone2, 1)
  for (const [amt, d] of [[6, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 0]] as const) await earn(elaine, amt, null, d)
  void gEarns

  // One pending redemption → shows in the approval queue
  await query(
    `insert into reward_redemptions (household_id, reward_id, person_id, title, emoji, cost, currency, status, requested_by)
     values ($1,$2,$3,'Ice cream sundae','🍨',30,'stars','pending',$3)`, [hh, rewardId['Ice cream sundae'], george])

  // ── Goals: a family group list (2 shared goals) + one individual list per person ──
  await seedGoals(ids)

  // ── Lists ────────────────────────────────────────────────────────────────────
  const grocery = await one<{ id: string }>(
    `insert into lists (household_id, name, emoji, list_type, sort_mode, sort_order)
     values ($1,'Grocery','🛒','grocery','aisle',0) returning id`, [hh])
  const items: Array<[string, string, string, boolean]> = [
    // name, quantity, aisle(category), checked
    ['Bananas', '1 bunch', 'Produce', false],
    ['Romaine lettuce', '2 heads', 'Produce', false],
    ['Fuji apples', '6', 'Produce', true],
    ['Whole milk', '1 gal', 'Dairy & Chilled', false],
    ['Eggs', '1 dozen', 'Dairy & Chilled', false],
    ['Butter', '1 lb', 'Dairy & Chilled', true],
    ['Chicken thighs', '2 lb', 'Meat & Seafood', false],
    ['Spaghetti', '2 boxes', 'Pantry', false],
    ['Marinara sauce', '1 jar', 'Pantry', true],
    ['Marble rye', '1 loaf', 'Bakery', false],
    ['Everything bagels', '4', 'Bakery', false],
    ["Ben & Jerry's", '1 pint', 'Frozen', true],
  ]
  for (const [i, [name, qty, cat, checked]] of items.entries())
    await query(
      `insert into list_items (household_id, list_id, name, quantity, category, status, checked, checked_at, checked_by, source, sort_order, created_by)
       values ($1,$2,$3,$4,$5,'active',$6,$7,$8,'manual',$9,$10)`,
      [hh, grocery.id, name, qty, cat, checked, checked ? new Date() : null, checked ? jerry : null, i, jerry])
  // A themed custom list
  const party = await one<{ id: string }>(
    `insert into lists (household_id, name, emoji, list_type, sort_order) values ($1,'Festivus prep','🎄','custom',1) returning id`, [hh])
  for (const [i, n] of ['Aluminum pole', 'Airing of grievances list', 'Feats of strength mat', 'TV dinners'].entries())
    await query(`insert into list_items (household_id, list_id, name, status, source, sort_order, created_by) values ($1,$2,$3,'active','manual',$4,$5)`, [hh, party.id, n, i, kramer])
  // Pantry staples (assumed in-house)
  for (const s of ['Olive oil', 'Garlic', 'Rice', 'Parmesan', 'Butter', 'Salt & pepper', 'Pasta', 'Eggs'])
    await query(`insert into pantry_staples (household_id, name) values ($1,$2) on conflict do nothing`, [hh, s])

  // ── Pantry inventory ─────────────────────────────────────────────────────────
  const pantry: Array<[string, string, string, string, number | null]> = [
    // name, location, amount, unit, expiresInDays
    ['Whole milk', 'Fridge', '1', 'gal', 3],
    ['Eggs', 'Fridge', '8', '', 12],
    ['Leftover Chinese', 'Fridge', '1', 'box', 2],
    ['Ketchup', 'Fridge', '1', 'bottle', null],
    ["Ben & Jerry's", 'Freezer', '1', 'pint', null],
    ['Frozen peas', 'Freezer', '2', 'bags', null],
    ['Spaghetti', 'Pantry', '3', 'boxes', null],
    ['Peanut butter', 'Pantry', '1', 'jar', 90],
    ['Cereal', 'Pantry', '2', 'boxes', 40],
  ]
  for (const [name, loc, amt, unit, exp] of pantry)
    await query(
      `insert into pantry_items (household_id, name, location, amount, unit, expires_on, added_on)
       values ($1,$2,$3,$4,$5, ${exp === null ? 'null' : "current_date + $6::int"}, current_date - 2)`,
      exp === null ? [hh, name, loc, amt, unit] : [hh, name, loc, amt, unit, exp])

  // ── Photos (emoji tiles — no blobs needed) ───────────────────────────────────
  const photos: Array<[string, string, string, string | null, number, number]> = [
    // caption, emoji, color, memory, takenDaysAgo, hearts
    ['Beach day in the Hamptons', '🏖️', '#7FC1E8', 'Hamptons Trip', 20, 5],
    ['Sandcastle contest', '🏖️', '#7FC1E8', 'Hamptons Trip', 20, 3],
    ["George's first home run", '⚾', '#8FCf7F', 'Little League', 12, 8],
    ["Elaine's piano recital", '🩰', '#E8A9D0', 'Recital', 9, 6],
    ['Festivus dinner', '🍽️', '#E0A44F', 'Festivus', 45, 4],
    ['Movie night at home', '🍿', '#C9A0E8', null, 6, 2],
    ['Soup from the soup place', '🍲', '#E8B84F', null, 4, 7],
    ['Fresh marble rye', '🍞', '#D8A45F', null, 3, 3],
  ]
  for (const [cap, emoji, color, memory, days, hearts] of photos)
    await query(
      `insert into photos (household_id, caption, emoji, color_hex, memory, taken_at, reactions, uploaded_by, created_by)
       values ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval, $7::jsonb, $8, $8)`,
      [hh, cap, emoji, color, memory, String(days), JSON.stringify({ heart: hearts }), jerry])

  // ── Calendar: a full week + countdowns ───────────────────────────────────────
  await timedEvent(hh, { title: "Dinner at Monk's Café", emoji: '🍽️', day: 0, time: '18:30', durMin: 90, person: jerry })
  await timedEvent(hh, { title: 'Dentist', emoji: '🦷', day: 0, time: '09:00', durMin: 45, person: jerry })
  await timedEvent(hh, { title: 'Stand-up set at the Comedy Cellar', emoji: '🎤', day: 1, time: '20:00', durMin: 60, person: jerry })
  await timedEvent(hh, { title: 'Ballet class', emoji: '🩰', day: 1, time: '16:00', durMin: 60, person: elaine })
  await timedEvent(hh, { title: 'Kramerica Industries meeting', emoji: '💼', day: 2, time: '10:00', durMin: 60, person: kramer })
  await timedEvent(hh, { title: 'Little League practice', emoji: '⚾', day: 2, time: '15:30', durMin: 90, person: george })
  await timedEvent(hh, { title: 'Piano lesson', emoji: '🎹', day: 3, time: '08:00', durMin: 45, person: elaine })
  await timedEvent(hh, { title: 'Coffee with Newman', emoji: '☕', day: 3, time: '12:30', durMin: 60, person: kramer })
  await allDayEvent(hh, { title: 'Field trip to the museum', emoji: '🏛️', day: 4, person: george })
  await timedEvent(hh, { title: 'Family movie night', emoji: '🎬', day: 4, time: '19:30', durMin: 120, person: jerry })
  await allDayEvent(hh, { title: 'Farmers market', emoji: '🥕', day: 5, person: kramer })
  await timedEvent(hh, { title: 'Brunch with the gang', emoji: '🥞', day: 6, time: '11:00', durMin: 90, person: jerry })
  // Countdowns
  await allDayEvent(hh, { title: 'Trip to the Hamptons', emoji: '🏖️', day: 21, person: jerry, countdown: true })
  await allDayEvent(hh, { title: 'First day of school', emoji: '🎒', day: 44, person: george, countdown: true })
  await query(
    `insert into countdowns (household_id, title, date, emoji, color, created_by)
     values ($1,'Jerry''s comedy special taping', current_date + 30, '🎬','#4F7FE0',$2)`, [hh, jerry])

  writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2))
  console.log(`✅ base seeded — household "The Seinfelds" (${hh})`)
  console.log(`   people: Jerry(admin) ${jerry}  Kramer ${kramer}  George ${george}  Elaine ${elaine}`)
  console.log(`   login: jerry@seinfeld.demo / seinfeld123`)
  console.log(`   ids → ${IDS_FILE}`)
}

async function seedMeals() {
  const ids: Ids = JSON.parse(readFileSync(IDS_FILE, 'utf8'))
  const hh = ids.household
  const recipes = (await query<{ id: string; title: string }>(
    `select id, title from recipes where household_id=$1 and deleted_at is null order by random() limit 40`, [hh])).rows
  if (recipes.length === 0) throw new Error('No recipes in the demo DB yet — run the recipe copy step before `meals`.')

  // Active meal plan for this week (Sun-based)
  const plan = await one<{ id: string }>(
    `insert into meal_plans (household_id, start_date, end_date, status)
     values ($1, current_date, current_date + 6, 'active') returning id`, [hh])

  // Plan a dinner every day; a few breakfasts/lunches; mark past days cooked.
  const cooks = [ids.jerry, ids.kramer]
  let ri = 0
  for (let day = 0; day < 7; day++) {
    const recipe = recipes[ri++ % recipes.length]
    const cooked = day < 0 // (all this-week dinners are upcoming/planned; see cooked history below)
    await query(
      `insert into meal_plan_entries (meal_plan_id, household_id, date, meal_type, recipe_id, cook_person_id, status)
       values ($1,$2, current_date + $3::int, 'dinner', $4, $5, $6)`,
      [plan.id, hh, day, recipe.id, cooks[day % 2], cooked ? 'cooked' : 'planned'])
  }
  // A couple of breakfasts/lunches for a fuller week grid
  for (const [day, meal] of [[0, 'breakfast'], [2, 'lunch'], [5, 'breakfast']] as const) {
    const recipe = recipes[ri++ % recipes.length]
    await query(
      `insert into meal_plan_entries (meal_plan_id, household_id, date, meal_type, recipe_id, cook_person_id, status)
       values ($1,$2, current_date + $3::int, $4, $5, $6, 'planned')`, [plan.id, hh, day, meal, recipe.id, cooks[day % 2]])
  }

  // Make the library look lived-in: favorites + cooked history on ~12 recipes.
  const favs = recipes.slice(0, 8).map((r) => r.id)
  for (const [i, id] of favs.entries())
    await query(
      `update recipes set is_favorite=true, cooked_count=$2, last_cooked_at = now() - ($3 || ' days')::interval where id=$1`,
      [id, 2 + (i % 5), String(3 + i * 4)])
  for (const id of recipes.slice(8, 16).map((r) => r.id))
    await query(`update recipes set cooked_count = 1 + floor(random()*4)::int, last_cooked_at = now() - (floor(random()*40)||' days')::interval where id=$1`, [id])

  console.log(`✅ meals seeded — 1 active plan, ${7 + 3} entries, ${favs.length} favorites, cooked history on ~16 recipes`)
}

async function main() {
  const phase = process.argv[2]
  if (phase === 'base') await seedBase()
  else if (phase === 'meals') await seedMeals()
  else if (phase === 'goals') {
    await seedGoals(JSON.parse(readFileSync(IDS_FILE, 'utf8')))
    console.log('✅ goals reseeded — 1 family group (2 shared goals) + 4 individual lists')
  }
  else {
    console.error('usage: seed-demo <base|meals|goals>  (e.g. `node dist/seed-demo.js base` in-container, or `npx tsx scripts/seed-demo.ts base` on the host)')
    process.exit(1)
  }
  await closePool()
}

main().catch(async (e) => { console.error(e); await closePool(); process.exit(1) })
