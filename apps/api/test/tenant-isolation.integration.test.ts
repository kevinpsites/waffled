// Cross-household isolation regression suite. Every test here seeds TWO households
// and proves that household A cannot (a) write a row that references household B's
// person, nor (b) read household B's person back through a join that forgot its
// household predicate. Each `it` corresponds to a finding in the 2026-09-08 tenant
// isolation audit; keep them here (rather than scattered per module) so the whole
// guarantee is provable in one place, against one throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// Plants a row the composite (household_id, person_id) foreign keys refuse.
// Migration 0104 makes a cross-household person reference structurally impossible, so
// the read-path tests below can only reach their subject with referential triggers off
// — the same mechanism `scripts/admin.ts` uses to delete a household in any order. The
// read hardening is still worth proving: it is what contains a row planted before that
// migration ran, and what keeps a future missed guard from disclosing a stranger.
async function seedBypassingForeignKeys(fn: (c: Client) => Promise<void>): Promise<void> {
  await withClient(async (c) => {
    await c.query('begin')
    try {
      await c.query(`set local session_replication_role = replica`)
      await fn(c)
      await c.query('commit')
    } catch (e) {
      await c.query('rollback')
      throw e
    }
  })
}

// Household A — the attacker's side. Owner is an admin (every capability).
const attacker = mint('dev|a-admin')
// A non-admin kid in A, for the "acting on behalf of another member" checks.
const attackerKid = mint('dev|a-kid')
// Household B — the victim's side. Its own admin, so B can read its own boards.
const victim = mint('dev|b-admin')

let householdA = ''
let householdB = ''
let aAdminId = ''
let aKidId = ''
let aSiblingId = ''
let bAdminId = ''
// The victim: a person in household B whose UUID the attacker somehow knows.
let bPersonId = ''
const VICTIM_NAME = 'SECRET-VICTIM-NAME'

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Attackers', timezone: 'UTC' },
    admin: { name: 'Ada', email: 'ada@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const setupBody = JSON.parse(setup.body)
  householdA = setupBody.household.id
  aAdminId = setupBody.person.id

  await withClient(async (c) => {
    const identity = (householdId: string, personId: string, sub: string) =>
      c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
         values ($1,$2,'password',$3,true)`,
        [householdId, personId, sub]
      )
    const person = async (householdId: string, name: string, memberType: string, isAdmin: boolean) =>
      (await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin) values ($1,$2,$3,$4) returning id`,
        [householdId, name, memberType, isAdmin]
      )).rows[0].id

    await identity(householdA, aAdminId, 'dev|a-admin')
    aKidId = await person(householdA, 'Kid A', 'kid', false)
    await identity(householdA, aKidId, 'dev|a-kid')
    aSiblingId = await person(householdA, 'Sib A', 'kid', false)

    householdB = (await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('Victims','UTC') returning id`
    )).rows[0].id
    bAdminId = await person(householdB, 'Bea', 'adult', true)
    await identity(householdB, bAdminId, 'dev|b-admin')
    bPersonId = await person(householdB, VICTIM_NAME, 'kid', false)

    // Family Night is off by default; household A needs it on to reach its routes.
    await c.query(
      `update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"familyNight":true}}'::jsonb
        where id = $1`,
      [householdA]
    )
  })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// ---- Finding 1 — spot award (cross-household WRITE) -------------------------
// The only finding where household A can change what household B sees: the award
// wrote a ledger row stamped with A's household_id but B's person_id, and the
// chores summary joined the balances view on person_id alone.
describe('spot award cannot reach another household', () => {
  it('refuses a spot award aimed at a person outside the household', async () => {
    const res = await call('POST', `/api/persons/${bPersonId}/award`, attacker, { amount: 999, note: 'pwned' })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from ledger_entries where person_id = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it("never counts a foreign household's ledger row on the victim's Today board", async () => {
    // Independent of the route guard: seed the poisoned row exactly as the bug
    // wrote it (A's household_id, B's person_id) plus a legitimate row in B, so
    // this test still fails if only the write guard were fixed.
    await seedBypassingForeignKeys(async (c) => {
      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',999,'spot_award')`,
        [householdA, bPersonId]
      )
      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',7,'chore_completed')`,
        [householdB, bPersonId]
      )
    })
    const res = await call('GET', '/api/chores/today', victim)
    expect(res.statusCode).toBe(200)
    const people = JSON.parse(res.body).people as { id: string; stars: number }[]
    const rows = people.filter((p) => p.id === bPersonId)
    // Exactly one row: the unpredicated join also duplicated a person who already
    // had a legitimate balance.
    expect(rows.length).toBe(1)
    expect(rows[0].stars).toBe(7)
  })
})

// ---- Finding 2 — reward redemption ------------------------------------------
describe('reward redemption cannot reach another household', () => {
  it('refuses a redemption filed for a person outside the household', async () => {
    const reward = await call('POST', '/api/rewards', attacker, { title: 'Ice cream', cost: 5, requiresApproval: true })
    expect(reward.statusCode).toBe(201)
    const rewardId = JSON.parse(reward.body).reward.id as string

    const res = await call('POST', `/api/rewards/${rewardId}/redeem`, attacker, { personId: bPersonId })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from reward_redemptions where person_id = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it('never discloses a foreign person through the redemptions list', async () => {
    // Independent of the write guard: a row already on file (or written by some
    // future missed guard) must still not resolve a stranger's profile.
    await seedBypassingForeignKeys(async (c) => {
      const reward = await c.query<{ id: string }>(
        `insert into rewards (household_id, title, cost, currency) values ($1,'Poisoned',1,'stars') returning id`,
        [householdA]
      )
      await c.query(
        `insert into reward_redemptions (household_id, reward_id, person_id, title, cost, currency, status)
         values ($1,$2,$3,'Poisoned',1,'stars','pending')`,
        [householdA, reward.rows[0].id, bPersonId]
      )
    })
    const res = await call('GET', '/api/redemptions', attacker)
    expect(res.statusCode).toBe(200)
    const redemptions = JSON.parse(res.body).redemptions as { personId: string; personName: string | null }[]
    const poisoned = redemptions.find((r) => r.personId === bPersonId)
    expect(poisoned).toBeTruthy()
    expect(poisoned?.personName).toBe(null)
    expect(res.body).not.toContain(VICTIM_NAME)
  })
})

// ---- Finding 6 — redeeming on behalf of another member ----------------------
// Same rule its sibling POST /api/conversions/:id/apply already enforces: your own
// balance is yours to spend, someone else's needs the reward.manage capability.
describe('redeeming for another member needs the capability', () => {
  it('lets a kid redeem for themselves but not for a sibling', async () => {
    const reward = await call('POST', '/api/rewards', attacker, { title: 'Movie night', cost: 3, requiresApproval: true })
    const rewardId = JSON.parse(reward.body).reward.id as string

    const own = await call('POST', `/api/rewards/${rewardId}/redeem`, attackerKid, { personId: aKidId })
    expect(own.statusCode).toBe(201)

    const onBehalf = await call('POST', `/api/rewards/${rewardId}/redeem`, attackerKid, { personId: aSiblingId })
    expect(onBehalf.statusCode).toBe(403)

    // An admin (who holds reward.manage) still can.
    const byAdmin = await call('POST', `/api/rewards/${rewardId}/redeem`, attacker, { personId: aSiblingId })
    expect(byAdmin.statusCode).toBe(201)
  })
})

// ---- Follow-up to finding 6 — the same rule, through the capture bar --------
// The route gate is only half the door. /api/capture/commit reaches the very same
// requestRedemption via the rewards capture target, and it resolves a spoken name
// ("Sib A spent 3 stars on ice cream") into that person's id — so without the same
// capability check a kid could spend a sibling's balance by naming them. No tenant
// leak (findPersonByName is household-scoped); this is the in-household half.
describe('redeeming for another member through capture needs the capability', () => {
  const commit = (token: string, rewardId: string, personName?: string) =>
    call('POST', '/api/capture/commit', token, {
      verb: 'redeem',
      targetKind: 'reward',
      targetId: rewardId,
      args: personName ? { personName } : {},
    })

  it('refuses a kid naming a sibling, and leaves the sibling’s balance intact', async () => {
    // Approval OFF is the only shape that actually spends — an approval-gated reward
    // just queues a request, so it would prove nothing about the money.
    const reward = await call('POST', '/api/rewards', attacker, { title: 'Ice cream', cost: 3, requiresApproval: false })
    expect(reward.statusCode).toBe(201)
    const rewardId = JSON.parse(reward.body).reward.id as string

    // Fund both kids, so a refusal can never be mistaken for "not enough stars".
    for (const id of [aKidId, aSiblingId]) {
      expect((await call('POST', `/api/persons/${id}/award`, attacker, { amount: 10 })).statusCode).toBe(201)
    }
    const stars = (personId: string) =>
      withClient(async (c) =>
        Number(
          (
            await c.query<{ balance: string }>(
              `select coalesce(sum(amount),0) as balance from ledger_entries
                 where household_id=$1 and person_id=$2 and deleted_at is null`,
              [householdA, personId]
            )
          ).rows[0].balance
        )
      )

    // Spending your OWN balance through capture stays allowed.
    expect((await commit(attackerKid, rewardId)).statusCode).toBe(200)
    expect(await stars(aKidId)).toBe(7)

    // Naming a sibling is a parent action.
    expect((await commit(attackerKid, rewardId, 'Sib A')).statusCode).toBe(403)
    expect(await stars(aSiblingId)).toBe(10)

    // An admin (who holds reward.manage) still can.
    expect((await commit(attacker, rewardId, 'Sib A')).statusCode).toBe(200)
    expect(await stars(aSiblingId)).toBe(7)
  })
})

// ---- Finding 3 — photo uploadedBy -------------------------------------------
describe('photo attribution cannot reach another household', () => {
  it('refuses a photo attributed to a person outside the household', async () => {
    const res = await call('POST', '/api/photos', attacker, { emoji: '📷', caption: 'Nope', uploadedBy: bPersonId })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from photos where uploaded_by = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it('never discloses a foreign uploader when listing photos', async () => {
    await seedBypassingForeignKeys((c) =>
      c.query(
        `insert into photos (household_id, emoji, caption, uploaded_by) values ($1,'🖼️','Poisoned',$2)`,
        [householdA, bPersonId]
      ).then(() => undefined)
    )
    const res = await call('GET', '/api/photos', attacker)
    expect(res.statusCode).toBe(200)
    const photos = JSON.parse(res.body).photos as { caption: string; uploadedBy: { personId: string; name: string | null } | null }[]
    const poisoned = photos.find((p) => p.caption === 'Poisoned')
    expect(poisoned?.uploadedBy?.personId).toBe(bPersonId)
    expect(poisoned?.uploadedBy?.name ?? null).toBe(null)
    expect(res.body).not.toContain(VICTIM_NAME)
  })
})

// ---- Finding 4 — ICS feed owner ---------------------------------------------
describe('calendar feed owners cannot reach another household', () => {
  it('refuses a feed owned by a person outside the household', async () => {
    const res = await call('POST', '/api/calendar/feeds', attacker, {
      url: 'https://example.com/foreign.ics',
      name: 'Foreign',
      personId: bPersonId,
    })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from ics_feeds where person_id = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it('refuses moving an existing feed onto a person outside the household', async () => {
    const created = await call('POST', '/api/calendar/feeds', attacker, {
      url: 'https://example.com/ours.ics',
      name: 'Ours',
      personId: aKidId,
    })
    expect(created.statusCode).toBe(201)
    const feedId = JSON.parse(created.body).feed.id as string

    const res = await call('PATCH', `/api/calendar/feeds/${feedId}`, attacker, { personId: bPersonId })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query<{ person_id: string }>(`select person_id from ics_feeds where id = $1`, [feedId])
    )
    expect(rows[0].person_id).toBe(aKidId)
  })

  it('never discloses a foreign feed owner when listing feeds', async () => {
    await seedBypassingForeignKeys((c) =>
      c.query(
        `insert into ics_feeds (household_id, url, name, person_id, visibility)
         values ($1,'https://example.com/poisoned.ics','Poisoned',$2,'family')`,
        [householdA, bPersonId]
      ).then(() => undefined)
    )
    const res = await call('GET', '/api/calendar/feeds', attacker)
    expect(res.statusCode).toBe(200)
    const feeds = JSON.parse(res.body).feeds as { name: string; personName: string | null }[]
    expect(feeds.find((f) => f.name === 'Poisoned')?.personName).toBe(null)
    expect(res.body).not.toContain(VICTIM_NAME)
  })
})

// ---- Finding 5 — Family Night assignments -----------------------------------
// Inert today (the agenda resolves names against the household's own members, so a
// foreign id shows as an empty slot), but it is the same unguarded write; guard it
// so the next change to that read path cannot turn it into a disclosure.
describe('family night assignments cannot reach another household', () => {
  it('refuses an agenda slot assigned to a person outside the household', async () => {
    const view = await call('GET', '/api/family-night', attacker)
    expect(view.statusCode).toBe(200)
    const partId = JSON.parse(view.body).config.parts[0].id as string

    const res = await call('POST', '/api/family-night/occurrence', attacker, {
      date: '2026-01-02',
      assignments: [{ partId, personId: bPersonId }],
    })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from family_night_assignments where person_id = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it('still accepts an assignment to a member of the household', async () => {
    const view = await call('GET', '/api/family-night', attacker)
    const partId = JSON.parse(view.body).config.parts[0].id as string
    const res = await call('POST', '/api/family-night/occurrence', attacker, {
      date: '2026-01-09',
      assignments: [{ partId, personId: aKidId }],
    })
    expect(res.statusCode).toBe(200)
  })
})

// ---- Finding 7 — /api/health aggregates -------------------------------------
describe('the health report counts only the caller household', () => {
  it("does not report another household's calendar backlog", async () => {
    await withClient((c) =>
      c.query(
        `insert into events (household_id, title, starts_at, timezone, sync_state)
         values ($1,'Stuck', now(), 'UTC', 'push_failed')`,
        [householdA]
      )
    )
    const mine = await call('GET', '/api/health', attacker)
    expect(mine.statusCode).toBe(200)
    expect(JSON.parse(mine.body).checks.calendar.failedPush).toBe(1)

    // Household B has no stuck events of its own — and must not learn A does.
    const theirs = await call('GET', '/api/health', victim)
    expect(theirs.statusCode).toBe(200)
    expect(JSON.parse(theirs.body).checks.calendar.failedPush).toBe(0)
    expect(JSON.parse(theirs.body).checks.calendar.status).toBe('ok')
  })
})
