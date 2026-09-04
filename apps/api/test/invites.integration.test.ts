// P2.4 of multi-household identity (docs/design/multi-household-identity.md §5.5,
// decision 1): invite-and-accept. An admin invites an existing account's email to
// their household; that creates a PENDING invite (not an instant membership). The
// invited account sees it on next login and accepts, which creates their membership
// (a persons row linked to their account). No one is attached without their OK.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let kevinToken = ''   // admin/owner of household A
let teenToken = ''    // non-admin member of household A
let householdA = ''
let householdB = ''
let bobAccountId = ''

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown): Promise<RunResult> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)
const login = async (email: string, password: string) => json(await call('POST', '/api/auth/login', undefined, { email, password }))

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  process.env.LOCAL_JWT_SECRET = SECRET
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))
  const { hashPassword } = await import('../src/modules/auth/auth')

  // Household A: owner Kevin + a non-admin teen, both with logins.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinToken = json(setup).accessToken
  householdA = (await query(`select household_id from persons where name='Kevin'`)).rows[0].household_id
  const teenId = json(await call('POST', '/api/persons', kevinToken, { name: 'Teeny', memberType: 'teen' })).person.id
  await call('PUT', `/api/persons/${teenId}/login`, kevinToken, { email: 'teen@example.com', password: 'teenpass12' })
  teenToken = (await login('teen@example.com', 'teenpass12')).accessToken

  // Household B with its own existing account, Bob (so bob@example.com is a real,
  // loginable account that already belongs to another household).
  householdB = (await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)).rows[0].id
  const bobAcct = await query(
    `insert into accounts (email, password_hash, last_household_id) values ('bob@example.com',$1,$2) returning id`,
    [hashPassword('bobpass12'), householdB]
  )
  bobAccountId = bobAcct.rows[0].id
  await query(
    `insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'Bob','adult',true,$2) returning id`,
    [householdB, bobAccountId]
  )

  const helperAcct = await query(
    `insert into accounts (email, password_hash, last_household_id) values ('helper@example.com',$1,$2) returning id`,
    [hashPassword('helperpass12'), householdB]
  )
  await query(
    `insert into persons (household_id, name, member_type, is_admin, account_id)
     values ($1,'Helper','adult',false,$2)`,
    [householdB, helperAcct.rows[0].id]
  )

  const lockedAcct = await query(
    `insert into accounts (email, password_hash, last_household_id) values ('locked@example.com',$1,$2) returning id`,
    [hashPassword('lockedpass12'), householdB]
  )
  await query(
    `insert into persons (household_id, name, member_type, account_id, access_expires_at)
     values ($1,'Locked Helper','caregiver',$2,now() - interval '1 day')`,
    [householdA, lockedAcct.rows[0].id]
  )

  const strandedAcct = await query(
    `insert into accounts (email, password_hash, last_household_id) values ('stranded@example.com',$1,$2) returning id`,
    [hashPassword('strandedpass12'), householdB]
  )
  await query(
    `insert into persons (household_id, name, member_type, account_id, access_expires_at)
     values ($1,'Stranded Helper','caregiver',$2,now() - interval '1 day')`,
    [householdB, strandedAcct.rows[0].id]
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P2.4 invite-and-accept', () => {
  let inviteId = ''

  it('an admin invites an existing account by email → a pending invite (201)', async () => {
    const r = await call('POST', '/api/households/invites', kevinToken, { email: 'bob@example.com', memberType: 'adult', isAdmin: false })
    expect(r.statusCode).toBe(201)
    inviteId = json(r).invite.id
    expect(inviteId).toBeTruthy()
    // it did NOT create a membership yet
    const members = await query(`select 1 from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, bobAccountId])
    expect(members.rows).toHaveLength(0)
  })

  it('a non-admin cannot invite (403)', async () => {
    expect((await call('POST', '/api/households/invites', teenToken, { email: 'x@example.com' })).statusCode).toBe(403)
  })

  it('validates temporary role, admin, and expiration combinations', async () => {
    expect((await call('POST', '/api/households/invites', kevinToken, {
      email: 'bad-admin@example.com', memberType: 'guest', isAdmin: true,
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/households/invites', kevinToken, {
      email: 'bad-expiry@example.com', memberType: 'adult', accessEndsOn: '2099-06-15',
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/households/invites', kevinToken, {
      email: 'past@example.com', memberType: 'caregiver', accessEndsOn: '2020-01-01',
    })).statusCode).toBe(400)
  })

  it('lets an expired-only account return through a fresh temporary invite', async () => {
    const accessEndsOn = '2099-06-15'
    const invitation = await call('POST', '/api/households/invites', kevinToken, {
      email: 'locked@example.com', memberType: 'guest', accessEndsOn,
    })
    expect(invitation.statusCode).toBe(201)

    // There is no active tenant in which to show an accept screen. Successful
    // credential login bootstraps the fresh invite and lands in that household.
    const session = await login('locked@example.com', 'lockedpass12')
    expect(session.memberships).toHaveLength(1)
    expect(session.memberships[0]).toMatchObject({ householdId: householdA, memberType: 'guest' })
    expect(session.pendingInvites).toHaveLength(0)

    const restored = await query(
      `select member_type, access_expires_at from persons p join accounts a on a.id = p.account_id
        where p.household_id = $1 and lower(a.email) = 'locked@example.com'`,
      [householdA]
    )
    expect(restored.rows).toHaveLength(1)
    expect(restored.rows[0].member_type).toBe('guest')
    expect(new Date(restored.rows[0].access_expires_at).toISOString()).toBe('2099-06-16T05:00:00.000Z')
  })

  it('returns a controlled denial when an expired-only account has no fresh invite', async () => {
    const denied = await call('POST', '/api/auth/login', undefined, {
      email: 'stranded@example.com', password: 'strandedpass12',
    })
    expect(denied.statusCode).toBe(403)
    expect(json(denied)).toMatchObject({ error: 'Forbidden', message: 'No active household access for this account.' })
  })

  it('cannot invite someone already a member of the household (409)', async () => {
    expect((await call('POST', '/api/households/invites', kevinToken, { email: 'kevin@example.com' })).statusCode).toBe(409)
  })

  it('the invited account sees the pending invite on login and via GET /api/auth/invites', async () => {
    const d = await login('bob@example.com', 'bobpass12')
    expect(d.pendingInvites).toHaveLength(1)
    expect(d.pendingInvites[0]).toMatchObject({ householdId: householdA })
    const bobToken = d.accessToken

    const list = json(await call('GET', '/api/auth/invites', bobToken))
    expect(list.invites).toHaveLength(1)
    expect(list.invites[0]).toMatchObject({ id: inviteId, householdId: householdA, householdName: 'A' })
  })

  it('accepting creates the membership; the account can then switch into it', async () => {
    const bobToken = (await login('bob@example.com', 'bobpass12')).accessToken
    const acc = await call('POST', `/api/auth/invites/${inviteId}/accept`, bobToken)
    expect(acc.statusCode).toBe(201)

    // a membership in A now exists for Bob's account
    const m = await query(`select id, member_type, is_admin from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, bobAccountId])
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0].is_admin).toBe(false)

    // Bob can switch into A and is listed among A's people
    const sw = json(await call('POST', '/api/auth/switch', bobToken, { householdId: householdA }))
    expect(json(await call('GET', '/api/household', sw.accessToken)).household.name).toBe('A')
    const names = json(await call('GET', '/api/persons', sw.accessToken)).persons.map((p: { name: string }) => p.name)
    expect(names).toContain('Bob')

    // the invite is no longer pending
    expect((await login('bob@example.com', 'bobpass12')).pendingInvites).toHaveLength(0)
  })

  it('carries caregiver access expiration into a hidden membership', async () => {
    const accessEndsOn = '2099-06-15'
    const invite = json(await call('POST', '/api/households/invites', kevinToken, {
      email: 'helper@example.com', memberType: 'caregiver', accessEndsOn,
    })).invite
    expect(invite).toMatchObject({ memberType: 'caregiver', isAdmin: false })
    expect(new Date(invite.accessExpiresAt).toISOString()).toBe('2099-06-16T05:00:00.000Z')

    const helperToken = (await login('helper@example.com', 'helperpass12')).accessToken
    const accepted = await call('POST', `/api/auth/invites/${invite.id}/accept`, helperToken)
    expect(accepted.statusCode).toBe(201)
    expect(json(accepted).membership).toMatchObject({ memberType: 'caregiver', isAdmin: false })

    const membership = await query(
      `select p.member_type, p.is_admin, p.show_on_kiosk, p.access_expires_at
         from persons p join accounts a on a.id=p.account_id
        where p.household_id=$1 and lower(a.email)='helper@example.com'`,
      [householdA]
    )
    expect(membership.rows[0]).toMatchObject({ member_type: 'caregiver', is_admin: false, show_on_kiosk: false })
    expect(membership.rows[0].access_expires_at.toISOString()).toBe('2099-06-16T05:00:00.000Z')
  })

  it('rejects accepting an invite addressed to a different email (403)', async () => {
    // a fresh invite for carol, but Bob (logged in) tries to accept it
    const carolInvite = json(await call('POST', '/api/households/invites', kevinToken, { email: 'carol@example.com' })).invite.id
    const bobToken = (await login('bob@example.com', 'bobpass12')).accessToken
    expect((await call('POST', `/api/auth/invites/${carolInvite}/accept`, bobToken)).statusCode).toBe(403)
  })

  it('an admin can revoke a pending invite', async () => {
    const r = json(await call('POST', '/api/households/invites', kevinToken, { email: 'dave@example.com' }))
    const id = r.invite.id
    expect((await call('DELETE', `/api/households/invites/${id}`, kevinToken)).statusCode).toBeLessThan(300)
    // revoked invites don't show in the household's pending list
    const list = json(await call('GET', '/api/households/invites', kevinToken))
    expect(list.invites.find((i: { id: string }) => i.id === id)).toBeUndefined()
  })

  it('revalidates a stale invite inside the membership transaction', async () => {
    const { createMembershipFromInvite } = await import('../src/modules/auth/accounts')
    const account = await query(
      `insert into accounts (email, password_hash, last_household_id)
       values ('race-helper@example.com', null, $1) returning id`,
      [householdA]
    )
    const accountId = account.rows[0].id
    const expiredPerson = await query(
      `insert into persons (household_id, name, member_type, account_id, access_expires_at)
       values ($1, 'Race Helper', 'caregiver', $2, clock_timestamp() - interval '1 day') returning id`,
      [householdA, accountId]
    )
    const pending = await query(
      `insert into household_invites
         (household_id, email, member_type, is_admin, access_expires_at, invited_by)
       values ($1, 'race-helper@example.com', 'guest', false,
               clock_timestamp() + interval '1 day',
               (select owner_person_id from households where id = $1))
       returning id, household_id, member_type, is_admin, access_expires_at`,
      [householdA]
    )
    const stale = pending.rows[0]

    // Model the race directly: a caller loaded a valid invite, then the admin
    // revoked it before the membership transaction acquired its decision lock.
    await query(`update household_invites set revoked_at = clock_timestamp() where id = $1`, [stale.id])

    await expect(createMembershipFromInvite(accountId, 'race-helper@example.com', {
      id: stale.id,
    })).rejects.toMatchObject({ statusCode: 403 })

    const membership = await query(
      `select id, member_type, access_expires_at from persons
        where household_id = $1 and account_id = $2 and deleted_at is null`,
      [householdA, accountId]
    )
    expect(membership.rows).toHaveLength(1)
    expect(membership.rows[0].id).toBe(expiredPerson.rows[0].id)
    expect(membership.rows[0].member_type).toBe('caregiver')
    expect(membership.rows[0].access_expires_at.getTime()).toBeLessThan(Date.now())

    const invite = await query(`select accepted_at, revoked_at from household_invites where id = $1`, [stale.id])
    expect(invite.rows[0].accepted_at).toBeNull()
    expect(invite.rows[0].revoked_at).not.toBeNull()
  })

  it('rejects an invite whose deadline has passed before the locked decision', async () => {
    const { createMembershipFromInvite } = await import('../src/modules/auth/accounts')
    const { getPool } = await import('../src/platform/db')
    const account = await query(
      `insert into accounts (email, password_hash, last_household_id)
       values ('deadline-helper@example.com', null, $1) returning id`,
      [householdA]
    )
    const expiredInvite = await query(
      `insert into household_invites
         (household_id, email, member_type, is_admin, access_expires_at, invited_by)
       values ($1, 'deadline-helper@example.com', 'guest', false,
               clock_timestamp() + interval '150 milliseconds',
               (select owner_person_id from households where id = $1))
       returning id, household_id, member_type, is_admin, access_expires_at`,
      [householdA]
    )
    const stale = expiredInvite.rows[0]

    // Hold the row across the deadline. The accepting transaction begins while the
    // invite is still valid, then waits on FOR UPDATE until after it expires. A
    // transaction-start `now()` check would incorrectly accept this invite.
    const blocker = await getPool().connect()
    await blocker.query('begin')
    await blocker.query(`select id from household_invites where id = $1 for update`, [stale.id])
    const acceptance = createMembershipFromInvite(account.rows[0].id, 'deadline-helper@example.com', {
      id: stale.id,
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await blocker.query('commit')
    blocker.release()

    await expect(acceptance).rejects.toMatchObject({ statusCode: 403 })

    expect((await query(
      `select 1 from persons where household_id = $1 and account_id = $2 and deleted_at is null`,
      [householdA, account.rows[0].id]
    )).rows).toHaveLength(0)
    expect((await query(
      `select accepted_at from household_invites where id = $1`,
      [stale.id]
    )).rows[0].accepted_at).toBeNull()
  })

  it('keeps a concurrent duplicate acceptance idempotent for the active membership', async () => {
    const { createMembershipFromInvite } = await import('../src/modules/auth/accounts')
    const account = await query(
      `insert into accounts (email, password_hash, last_household_id)
       values ('duplicate-helper@example.com', null, $1) returning id`,
      [householdA]
    )
    const invitation = await query(
      `insert into household_invites
         (household_id, email, member_type, is_admin, invited_by)
       values ($1, 'duplicate-helper@example.com', 'caregiver', false,
               (select owner_person_id from households where id = $1))
       returning id`,
      [householdA]
    )

    const first = await createMembershipFromInvite(
      account.rows[0].id, 'duplicate-helper@example.com', { id: invitation.rows[0].id }
    )
    const duplicate = await createMembershipFromInvite(
      account.rows[0].id, 'duplicate-helper@example.com', { id: invitation.rows[0].id }
    )

    expect(first.created).toBe(true)
    expect(duplicate).toMatchObject({
      created: false,
      personId: first.personId,
      householdId: householdA,
      memberType: 'caregiver',
    })
    expect((await query(
      `select 1 from persons where household_id = $1 and account_id = $2 and deleted_at is null`,
      [householdA, account.rows[0].id]
    )).rows).toHaveLength(1)
  })
})
