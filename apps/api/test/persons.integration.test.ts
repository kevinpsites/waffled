// Members CRUD against a real Postgres (Testcontainers), scoped per household.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'waffled-local',
    audience: 'waffled-api',
    expiresIn: '1h',
  })
}

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    {
      httpMethod: method,
      path,
      headers,
      queryStringParameters: {},
      body: body !== undefined ? JSON.stringify(body) : null,
      isBase64Encoded: false,
    },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')
const kelly = mint('dev|kelly')
let kevinHouseholdId = ''
let kevinOwnerId = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const { query } = await import('../src/platform/db')

  // First-run onboarding creates Kevin's household + owner admin. Self-serve
  // POST /api/households is now admin-gated; mint('dev|kevin') resolves via the
  // identity seeded below.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinHouseholdId = JSON.parse(setup.body).household.id
  kevinOwnerId = JSON.parse(setup.body).person.id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [kevinHouseholdId, kevinOwnerId]
  )

  // Second household to prove isolation. Setup is now locked, so seed Kelly's
  // household + admin owner directly; mint('dev|kelly') resolves via this identity.
  const kh = await query<{ id: string }>(`insert into households (name, timezone) values ('Kelly HQ','UTC') returning id`)
  const kHid = kh.rows[0].id
  const kp = await query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Kelly','adult',true) returning id`,
    [kHid]
  )
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified) values ($1,$2,'password','dev|kelly','kelly@example.com',true)`,
    [kHid, kp.rows[0].id]
  )
})

// Seed a logged-in non-admin (teen) directly — the API has no invite flow yet.
async function seedNonAdmin(sub: string, householdId: string): Promise<void> {
  const { query } = await import('../src/platform/db')
  const p = await query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin)
     values ($1,'Teen','teen',false) returning id`,
    [householdId]
  )
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id)
     values ($1,$2,'password',$3)`,
    [householdId, p.rows[0].id, sub]
  )
}

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('GET /api/persons', () => {
  it('403s for a caller with no household', async () => {
    const res = await call('GET', '/api/persons', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })

  it('lists the household owner after provisioning', async () => {
    const res = await call('GET', '/api/persons', kevin)
    expect(res.statusCode).toBe(200)
    const { persons } = JSON.parse(res.body)
    expect(persons).toHaveLength(1)
    expect(persons[0]).toMatchObject({ name: 'Kevin', memberType: 'adult', isAdmin: true })
  })

  it('only returns the caller’s own household members', async () => {
    const mine = JSON.parse((await call('GET', '/api/persons', kevin)).body).persons
    const theirs = JSON.parse((await call('GET', '/api/persons', kelly)).body).persons
    expect(mine.map((p: { name: string }) => p.name)).toEqual(['Kevin'])
    expect(theirs.map((p: { name: string }) => p.name)).toEqual(['Kelly'])
  })
})

describe('POST /api/persons', () => {
  it('lets an admin add a kid, scoped to their household', async () => {
    const res = await call('POST', '/api/persons', kevin, {
      name: 'Ada',
      memberType: 'kid',
      avatarEmoji: '🦊',
      colorHex: '#FFCC00',
    })
    expect(res.statusCode).toBe(201)
    const { person } = JSON.parse(res.body)
    expect(person).toMatchObject({
      name: 'Ada',
      memberType: 'kid',
      isAdmin: false,
      avatarEmoji: '🦊',
      householdId: kevinHouseholdId,
    })

    const names = JSON.parse((await call('GET', '/api/persons', kevin)).body).persons.map(
      (p: { name: string }) => p.name
    )
    expect(names).toContain('Ada')
    expect(names).toContain('Kevin')
  })

  it('carries a birthday through the roster as a bare day', async () => {
    // The roster is built from `select * from persons`, so a wildcard can never cast
    // the `birthday` date column at the call site — the driver has to hand it over as
    // the day it is, or every read of it drifts by the API server's own timezone.
    const res = await call('POST', '/api/persons', kevin, {
      name: 'Birthday Kid', memberType: 'kid', birthday: '2015-11-02',
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).person.birthday).toBe('2015-11-02')

    const roster = JSON.parse((await call('GET', '/api/persons', kevin)).body).persons
    expect(roster.find((p: { name: string }) => p.name === 'Birthday Kid').birthday).toBe('2015-11-02')
  })

  it('rejects a missing or invalid memberType (400)', async () => {
    expect((await call('POST', '/api/persons', kevin, { name: 'NoType' })).statusCode).toBe(400)
    expect(
      (await call('POST', '/api/persons', kevin, { name: 'Bad', memberType: 'robot' })).statusCode
    ).toBe(400)
  })

  it('rejects a colorHex that is not a #RRGGBB hex (400)', async () => {
    for (const colorHex of ['red', '#FFF', '#12345', 'FFCC00', '#GGGGGG']) {
      const res = await call('POST', '/api/persons', kevin, { name: 'Bad color', memberType: 'kid', colorHex })
      expect(res.statusCode, `colorHex=${colorHex}`).toBe(400)
    }
  })

  it('accepts an off-palette custom hex', async () => {
    const res = await call('POST', '/api/persons', kevin, { name: 'Custom', memberType: 'kid', colorHex: '#0f9d58' })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).person.colorHex).toBe('#0f9d58')
  })

  it('creates temporary caregiver and guest roles hidden from the shared kiosk by default', async () => {
    const accessEndsOn = '2099-06-15'
    const caregiver = await call('POST', '/api/persons', kevin, {
      name: 'Casey',
      memberType: 'caregiver',
      accessEndsOn,
    })
    expect(caregiver.statusCode).toBe(201)
    expect(JSON.parse(caregiver.body).person).toMatchObject({
      name: 'Casey',
      memberType: 'caregiver',
      isAdmin: false,
      showOnKiosk: false,
    })
    // America/Chicago's exclusive next-midnight for the selected date (CDT).
    expect(new Date(JSON.parse(caregiver.body).person.accessExpiresAt).toISOString()).toBe('2099-06-16T05:00:00.000Z')

    const guest = await call('POST', '/api/persons', kevin, { name: 'Grace', memberType: 'guest' })
    expect(guest.statusCode).toBe(201)
    expect(JSON.parse(guest.body).person).toMatchObject({ memberType: 'guest', isAdmin: false, showOnKiosk: false })
  })

  it('rejects admin rights for restricted roles and expiration on permanent roles', async () => {
    expect((await call('POST', '/api/persons', kevin, {
      name: 'Admin Guest', memberType: 'guest', isAdmin: true,
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/persons', kevin, {
      name: 'Temporary Adult', memberType: 'adult', accessEndsOn: '2099-06-15',
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/persons', kevin, {
      name: 'Already Expired', memberType: 'caregiver', accessEndsOn: '2020-01-01',
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/persons', kevin, {
      name: 'Ambiguous', memberType: 'caregiver', accessEndsOn: '2099-06-15', accessExpiresAt: '2099-06-16T05:00:00.000Z',
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/persons', kevin, {
      name: 'Bad Visibility', memberType: 'guest', showOnKiosk: 'yes',
    })).statusCode).toBe(400)
  })

  it('enforces guest read-only access centrally while preserving reads', async () => {
    const created = JSON.parse((await call('POST', '/api/persons', kevin, {
      name: 'Read Only', memberType: 'guest',
    })).body).person
    const { query } = await import('../src/platform/db')
    await query(
      `insert into identities (household_id, person_id, provider, auth0_user_id)
       values ($1,$2,'password','dev|readonly-guest')`,
      [kevinHouseholdId, created.id]
    )
    const guestToken = mint('dev|readonly-guest')
    expect((await call('GET', '/api/persons', guestToken)).statusCode).toBe(200)
    expect((await call('POST', `/api/persons/${created.id}/saving-toward`, guestToken, {
      rewardId: null,
    })).statusCode).toBe(403)
  })

  it('rejects requests after a temporary membership expires', async () => {
    const { query } = await import('../src/platform/db')
    const p = await query<{ id: string }>(
      `insert into persons (household_id, name, member_type, access_expires_at)
       values ($1,'Expired Helper','caregiver',now() - interval '1 minute') returning id`,
      [kevinHouseholdId]
    )
    await query(
      `insert into identities (household_id, person_id, provider, auth0_user_id)
       values ($1,$2,'password','dev|expired-helper')`,
      [kevinHouseholdId, p.rows[0].id]
    )
    const denied = await call('GET', '/api/persons', mint('dev|expired-helper'))
    expect(denied.statusCode).toBe(401)
    expect(JSON.parse(denied.body)).toMatchObject({ error: 'membership_inactive' })
  })

  it('forbids a non-admin member from adding people (403)', async () => {
    await seedNonAdmin('dev|teen', kevinHouseholdId)
    const res = await call('POST', '/api/persons', mint('dev|teen'), {
      name: 'Sneaky',
      memberType: 'kid',
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET / PATCH /api/persons/:id', () => {
  let targetId = ''

  beforeAll(async () => {
    const res = await call('POST', '/api/persons', kevin, {
      name: 'Bram',
      memberType: 'kid',
      colorHex: '#111111',
    })
    targetId = JSON.parse(res.body).person.id
  })

  it('reads one member by id', async () => {
    const res = await call('GET', `/api/persons/${targetId}`, kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).person).toMatchObject({ id: targetId, name: 'Bram' })
  })

  it('updates whitelisted fields', async () => {
    const res = await call('PATCH', `/api/persons/${targetId}`, kevin, {
      name: 'Bram Jr',
      colorHex: '#222222',
      sortOrder: 5,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).person).toMatchObject({ name: 'Bram Jr', colorHex: '#222222' })
  })

  it('rejects an invalid memberType (400) and an empty patch (400)', async () => {
    expect(
      (await call('PATCH', `/api/persons/${targetId}`, kevin, { memberType: 'alien' })).statusCode
    ).toBe(400)
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, {})).statusCode).toBe(400)
  })

  it('rejects a colorHex that is not a #RRGGBB hex (400)', async () => {
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, { colorHex: 'blue' })).statusCode).toBe(400)
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, { colorHex: '#12345' })).statusCode).toBe(400)
    // …but a free custom hex is fine, and clearing it is still allowed.
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, { colorHex: '#0f9d58' })).statusCode).toBe(200)
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, { colorHex: null })).statusCode).toBe(200)
  })

  // Colors predate this validation, so a member can be holding something that
  // isn't #RRGGBB. The editor resends colorHex on every save, so a hard reject
  // would mean that member can never be saved again — not their name, not their
  // birthday, nothing. Resending the value we already hold is accepted (and
  // migrated to #RRGGBB where that's possible); only *new* bad input is rejected.
  it('accepts a legacy color the member already holds, and migrates it when it can', async () => {
    const { query } = await import('../src/platform/db')

    await query(`update persons set color_hex = 'person-3' where id = $1`, [targetId])
    const passthrough = await call('PATCH', `/api/persons/${targetId}`, kevin, { name: 'Bram Sr', colorHex: 'person-3' })
    expect(passthrough.statusCode).toBe(200)
    expect(JSON.parse(passthrough.body).person).toMatchObject({ name: 'Bram Sr', colorHex: 'person-3' })

    // A shorthand hex is recoverable — take the save and store the full form.
    await query(`update persons set color_hex = '#abc' where id = $1`, [targetId])
    const migrated = await call('PATCH', `/api/persons/${targetId}`, kevin, { name: 'Bram Sr', colorHex: '#abc' })
    expect(migrated.statusCode).toBe(200)
    expect(JSON.parse(migrated.body).person.colorHex).toBe('#aabbcc')

    // …but a *different* bad value is still new input, and still rejected.
    await query(`update persons set color_hex = 'person-3' where id = $1`, [targetId])
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, { colorHex: 'person-4' })).statusCode).toBe(400)
    await query(`update persons set color_hex = '#111111' where id = $1`, [targetId])
  })

  it('clears temporary access expiration when changing to a permanent role', async () => {
    const created = JSON.parse((await call('POST', '/api/persons', kevin, {
      name: 'Morgan', memberType: 'caregiver', accessEndsOn: '2099-06-15',
    })).body).person
    const updated = await call('PATCH', `/api/persons/${created.id}`, kevin, { memberType: 'adult' })
    expect(updated.statusCode).toBe(200)
    expect(JSON.parse(updated.body).person).toMatchObject({ memberType: 'adult', accessExpiresAt: null })
  })

  it('rejects an expiration on an existing permanent role', async () => {
    expect((await call('PATCH', `/api/persons/${targetId}`, kevin, {
      accessEndsOn: '2099-06-15',
    })).statusCode).toBe(400)
  })

  it('keeps the household owner an adult admin', async () => {
    expect((await call('PATCH', `/api/persons/${kevinOwnerId}`, kevin, { memberType: 'caregiver' })).statusCode).toBe(409)
    expect((await call('PATCH', `/api/persons/${kevinOwnerId}`, kevin, { isAdmin: false })).statusCode).toBe(409)
  })

  it('404s for an unknown or non-uuid id', async () => {
    expect((await call('GET', '/api/persons/not-a-uuid', kevin)).statusCode).toBe(404)
    expect(
      (
        await call('PATCH', '/api/persons/00000000-0000-0000-0000-000000000000', kevin, {
          name: 'x',
        })
      ).statusCode
    ).toBe(404)
  })

  it('is household-scoped: another household cannot read or edit (404)', async () => {
    expect((await call('GET', `/api/persons/${targetId}`, kelly)).statusCode).toBe(404)
    expect((await call('PATCH', `/api/persons/${targetId}`, kelly, { name: 'hax' })).statusCode).toBe(
      404
    )
  })

  it('forbids a non-admin from editing (403)', async () => {
    await seedNonAdmin('dev|teen2', kevinHouseholdId)
    expect(
      (await call('PATCH', `/api/persons/${targetId}`, mint('dev|teen2'), { name: 'x' })).statusCode
    ).toBe(403)
  })
})

describe('DELETE /api/persons/:id', () => {
  let victimId = ''

  beforeAll(async () => {
    const res = await call('POST', '/api/persons', kevin, { name: 'Temp', memberType: 'kid' })
    victimId = JSON.parse(res.body).person.id
  })

  it('soft-deletes a member (204) and drops them from the list', async () => {
    expect((await call('DELETE', `/api/persons/${victimId}`, kevin)).statusCode).toBe(204)
    expect((await call('GET', `/api/persons/${victimId}`, kevin)).statusCode).toBe(404)
    const names = JSON.parse((await call('GET', '/api/persons', kevin)).body).persons.map(
      (p: { name: string }) => p.name
    )
    expect(names).not.toContain('Temp')
  })

  it('refuses to delete the household owner (409)', async () => {
    expect((await call('DELETE', `/api/persons/${kevinOwnerId}`, kevin)).statusCode).toBe(409)
  })

  it('404s for an already-deleted or unknown id', async () => {
    expect((await call('DELETE', `/api/persons/${victimId}`, kevin)).statusCode).toBe(404)
    expect(
      (await call('DELETE', '/api/persons/00000000-0000-0000-0000-000000000000', kevin)).statusCode
    ).toBe(404)
  })

  it('is household-scoped (404 across households)', async () => {
    const created = await call('POST', '/api/persons', kevin, { name: 'Other', memberType: 'kid' })
    const otherId = JSON.parse(created.body).person.id
    expect((await call('DELETE', `/api/persons/${otherId}`, kelly)).statusCode).toBe(404)
  })

  it('forbids a non-admin from deleting (403)', async () => {
    const created = await call('POST', '/api/persons', kevin, { name: 'Three', memberType: 'kid' })
    const id = JSON.parse(created.body).person.id
    expect((await call('DELETE', `/api/persons/${id}`, mint('dev|teen'))).statusCode).toBe(403)
  })
})

describe('onboarding (settings.onboarding)', () => {
  it('is armed active (not opened) on a first-run setup household', async () => {
    const res = await call('GET', '/api/household', kevin)
    expect(res.statusCode).toBe(200)
    const { household } = JSON.parse(res.body)
    expect(household.settings?.onboarding?.status).toBe('active')
    expect(household.settings?.onboarding?.opened).toBeUndefined()
  })

  it('is absent on a household seeded outside the wizard', async () => {
    const { household } = JSON.parse((await call('GET', '/api/household', kelly)).body)
    expect(household.settings?.onboarding).toBeUndefined()
  })

  it('marks opened without clobbering status', async () => {
    const res = await call('PATCH', '/api/household/onboarding', kevin, { opened: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).onboarding).toMatchObject({ status: 'active', opened: true })
  })

  it('dismisses, leaving opened intact', async () => {
    const res = await call('PATCH', '/api/household/onboarding', kevin, { status: 'dismissed' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).onboarding).toMatchObject({ status: 'dismissed', opened: true })
  })

  it('rejects an invalid status (400)', async () => {
    expect((await call('PATCH', '/api/household/onboarding', kevin, { status: 'nope' })).statusCode).toBe(400)
  })

  it('rejects an empty patch (400)', async () => {
    expect((await call('PATCH', '/api/household/onboarding', kevin, {})).statusCode).toBe(400)
  })

  it('forbids a non-admin (403)', async () => {
    await seedNonAdmin('dev|ob-teen', kevinHouseholdId)
    expect((await call('PATCH', '/api/household/onboarding', mint('dev|ob-teen'), { opened: true })).statusCode).toBe(403)
  })
})

describe('display preferences (settings.display)', () => {
  it('is absent until set — the client resolves the default', async () => {
    const { household } = JSON.parse((await call('GET', '/api/household', kevin)).body)
    expect(household.settings?.display).toBeUndefined()
  })

  it('saves the event style and the whole-family color', async () => {
    const res = await call('PATCH', '/api/household/display', kevin, { eventStyle: 'tinted', familyColorHex: '#F97316' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).display).toMatchObject({ eventStyle: 'tinted', familyColorHex: '#F97316' })

    // Persisted, and merged (a later patch of one key keeps the other).
    const patched = await call('PATCH', '/api/household/display', kevin, { eventStyle: 'solid' })
    expect(JSON.parse(patched.body).display).toMatchObject({ eventStyle: 'solid', familyColorHex: '#F97316' })
    const { household } = JSON.parse((await call('GET', '/api/household', kevin)).body)
    expect(household.settings.display).toMatchObject({ eventStyle: 'solid', familyColorHex: '#F97316' })
  })

  it('rejects an unknown event style (400)', async () => {
    expect((await call('PATCH', '/api/household/display', kevin, { eventStyle: 'plaid' })).statusCode).toBe(400)
  })

  it('rejects a family color that is not a #RRGGBB hex (400)', async () => {
    for (const familyColorHex of ['orange', '#FFF', '#12345', 42]) {
      const res = await call('PATCH', '/api/household/display', kevin, { familyColorHex })
      expect(res.statusCode, `familyColorHex=${familyColorHex}`).toBe(400)
    }
  })

  it('rejects an empty patch (400)', async () => {
    expect((await call('PATCH', '/api/household/display', kevin, {})).statusCode).toBe(400)
    expect((await call('PATCH', '/api/household/display', kevin, { nope: true })).statusCode).toBe(400)
  })

  it('forbids a non-admin (403)', async () => {
    await seedNonAdmin('dev|display-teen', kevinHouseholdId)
    expect((await call('PATCH', '/api/household/display', mint('dev|display-teen'), { eventStyle: 'solid' })).statusCode).toBe(403)
  })

  it('is household-scoped (another household is untouched)', async () => {
    const { household } = JSON.parse((await call('GET', '/api/household', kelly)).body)
    expect(household.settings?.display).toBeUndefined()
  })
})

describe('optional modules (settings.modules)', () => {
  it('rejects a non-admin (403)', async () => {
    await seedNonAdmin('dev|mod-teen', kevinHouseholdId)
    expect((await call('PATCH', '/api/household/modules', mint('dev|mod-teen'), { pantry: true })).statusCode).toBe(403)
  })

  it('rejects a not-yet-built (planned) module (400)', async () => {
    // quotes is in the catalog but status:'planned' until built — not togglable yet.
    expect((await call('PATCH', '/api/household/modules', kevin, { quotes: true })).statusCode).toBe(400)
  })

  it('rejects an unknown module key (400)', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { nope: true })).statusCode).toBe(400)
  })

  it('rejects an empty patch (400)', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, {})).statusCode).toBe(400)
  })
})
