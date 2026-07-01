// Family Night — module gating, config, rotation suggestions, occurrence/assignment
// persistence, and the optional calendar event, against a real Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  const householdId = JSON.parse(setup.body).household.id
  const ownerId = JSON.parse(setup.body).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // Two more members so rotation has people to distribute across.
  await call('POST', '/api/persons', kevin, { name: 'Wally', memberType: 'kid' })
  await call('POST', '/api/persons', kevin, { name: 'Beaver', memberType: 'kid' })
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('family night', () => {
  it('is gated off by default (403)', async () => {
    expect((await call('GET', '/api/family-night', kevin)).statusCode).toBe(403)
  })

  it('enables the module', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { familyNight: true })).statusCode).toBe(200)
  })

  it('returns default config and rotation-suggested assignments', async () => {
    const res = await call('GET', '/api/family-night', kevin)
    expect(res.statusCode).toBe(200)
    const view = JSON.parse(res.body)
    // Default agenda: Activity · Treat · Check-in, on Monday.
    expect(view.config.parts.map((p: { id: string }) => p.id)).toEqual(['activity', 'treat', 'checkin'])
    expect(view.config.dayOfWeek).toBe(1)
    expect(dow(view.next.date)).toBe(1) // next date lands on the configured day
    expect(view.members).toHaveLength(3)
    // With 3 members and index 0, each rotating part gets a distinct person.
    const people = view.next.assignments.map((a: { personId: string }) => a.personId)
    expect(new Set(people).size).toBe(3)
    expect(view.next.assignments.every((a: { suggested: boolean }) => a.suggested)).toBe(true)
    expect(view.next.occurrenceId).toBeNull()
  })

  it('rotation shifts once a prior gathering exists', async () => {
    const before = JSON.parse((await call('GET', '/api/family-night', kevin)).body)
    const firstPerson = before.next.assignments[0].personId
    // Record a gathering a week before "next" — that bumps the rotation index.
    const prior = new Date(`${before.next.date}T00:00:00Z`)
    prior.setUTCDate(prior.getUTCDate() - 7)
    const priorDate = prior.toISOString().slice(0, 10)
    expect((await call('POST', '/api/family-night/occurrence', kevin, { date: priorDate, status: 'done' })).statusCode).toBe(200)

    const after = JSON.parse((await call('GET', '/api/family-night', kevin)).body)
    expect(after.next.assignments[0].personId).not.toBe(firstPerson)
  })

  it('persists an overridden assignment and a theme', async () => {
    const view = JSON.parse((await call('GET', '/api/family-night', kevin)).body)
    const date = view.next.date
    const wally = view.members.find((m: { name: string }) => m.name === 'Wally').id
    const save = await call('POST', '/api/family-night/occurrence', kevin, {
      date,
      theme: 'Board game night',
      assignments: [{ partId: 'activity', personId: wally }],
    })
    expect(save.statusCode).toBe(200)

    const after = JSON.parse((await call('GET', '/api/family-night', kevin)).body)
    expect(after.next.theme).toBe('Board game night')
    expect(after.next.occurrenceId).toBeTruthy()
    const activity = after.next.assignments.find((a: { partId: string }) => a.partId === 'activity')
    expect(activity.personId).toBe(wally)
    expect(activity.suggested).toBe(false)
    // Untouched parts stay on rotation (suggested).
    const treat = after.next.assignments.find((a: { partId: string }) => a.partId === 'treat')
    expect(treat.suggested).toBe(true)
  })

  it('updates the agenda config', async () => {
    const res = await call('PUT', '/api/family-night/config', kevin, {
      dayOfWeek: 0,
      parts: [
        { id: 'lesson', label: 'Lesson', emoji: '📖', rotates: true },
        { id: 'game', label: 'Game', emoji: '🎲', rotates: true },
      ],
    })
    expect(res.statusCode).toBe(200)
    const view = JSON.parse((await call('GET', '/api/family-night', kevin)).body)
    expect(view.config.dayOfWeek).toBe(0)
    expect(view.config.parts.map((p: { id: string }) => p.id)).toEqual(['lesson', 'game'])
    expect(dow(view.next.date)).toBe(0)
  })

  it('rejects an empty parts list (400)', async () => {
    expect((await call('PUT', '/api/family-night/config', kevin, { parts: [] })).statusCode).toBe(400)
  })

  it('requires a date to save an occurrence (400)', async () => {
    expect((await call('POST', '/api/family-night/occurrence', kevin, { theme: 'x' })).statusCode).toBe(400)
  })

  it('puts Family Night on the calendar and takes it off', async () => {
    const sched = await call('POST', '/api/family-night/schedule', kevin)
    expect(sched.statusCode).toBe(200)
    const eventId = JSON.parse(sched.body).eventId
    expect(eventId).toBeTruthy()

    const config = JSON.parse((await call('GET', '/api/family-night/config', kevin)).body).config
    expect(config.eventId).toBe(eventId)

    // The recurring master exists on the calendar.
    const ev = await call('GET', `/api/events/${eventId}`, kevin)
    expect(ev.statusCode).toBe(200)
    expect(JSON.parse(ev.body).event.rrule).toContain('FREQ=WEEKLY')

    expect((await call('DELETE', '/api/family-night/schedule', kevin)).statusCode).toBe(200)
    const after = JSON.parse((await call('GET', '/api/family-night/config', kevin)).body).config
    expect(after.eventId).toBeNull()
  })

  it('forbids a non-admin from changing config (403)', async () => {
    const { query } = await import('../src/platform/db')
    const hh = await query<{ id: string }>(`select id from households limit 1`)
    const p = await query<{ id: string }>(`insert into persons (household_id, name, member_type, is_admin) values ($1,'Teen','teen',false) returning id`, [hh.rows[0].id])
    await query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|fn-teen',true)`,
      [hh.rows[0].id, p.rows[0].id]
    )
    const teen = mint('dev|fn-teen')
    expect((await call('PUT', '/api/family-night/config', teen, { dayOfWeek: 3 })).statusCode).toBe(403)
    // ...but a member can still read and set assignments.
    expect((await call('GET', '/api/family-night', teen)).statusCode).toBe(200)
  })
})
