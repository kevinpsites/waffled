// Member management: an admin gives a family member a login (password and/or
// SSO-only email invite), the member signs in, and login can be removed. Fresh
// container so the instance starts uninitialized.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
}, 120_000)
afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('member login management', () => {
  let admin: string
  let owner: string
  let wally: string // a child profile we'll give a login
  let dana: string // an SSO-only invite

  it('sets up the admin and adds two member profiles', async () => {
    const setup = json(await call('POST', '/api/auth/setup', {
      household: { name: 'Sites', timezone: 'America/Chicago' },
      admin: { name: 'Kevin', email: 'kevin@example.com', password: 'hunter2hunter' },
    }))
    admin = setup.accessToken
    owner = setup.person.id

    wally = json(await call('POST', '/api/persons', { name: 'Wally', memberType: 'teen' }, admin)).person.id
    dana = json(await call('POST', '/api/persons', { name: 'Dana', memberType: 'adult' }, admin)).person.id

    // Neither has a login yet.
    const members = json(await call('GET', '/api/household/settings', undefined, admin)).members
    const w = members.find((m: { id: string }) => m.id === wally)
    expect(w).toMatchObject({ hasLogin: false, hasPassword: false, loginEmail: null })
  })

  it('gives a member a password login they can sign in with', async () => {
    expect((await call('PUT', `/api/persons/${wally}/login`, { email: 'wally@example.com', password: 'wallypass1' }, admin)).statusCode).toBe(200)

    const member = json(await call('GET', '/api/household/settings', undefined, admin)).members.find((m: { id: string }) => m.id === wally)
    expect(member).toMatchObject({ hasPassword: true, loginEmail: 'wally@example.com', hasLogin: true })

    // Wally can now log in, and his token resolves to the same household.
    const login = await call('POST', '/api/auth/login', { email: 'wally@example.com', password: 'wallypass1' })
    expect(login.statusCode).toBe(200)
    expect(json(await call('GET', '/api/household', undefined, json(login).accessToken))).toMatchObject({ provisioned: true })
  })

  it('rejects a non-admin creating logins', async () => {
    const wallyToken = json(await call('POST', '/api/auth/login', { email: 'wally@example.com', password: 'wallypass1' })).accessToken
    // Wally is a teen, not admin.
    expect((await call('PUT', `/api/persons/${dana}/login`, { email: 'x@example.com', password: 'pwpwpwpw' }, wallyToken)).statusCode).toBe(403)
  })

  it('supports an SSO-only invite (email, no password)', async () => {
    expect((await call('PUT', `/api/persons/${dana}/login`, { email: 'dana@example.com' }, admin)).statusCode).toBe(200)
    const member = json(await call('GET', '/api/household/settings', undefined, admin)).members.find((m: { id: string }) => m.id === dana)
    expect(member).toMatchObject({ loginEmail: 'dana@example.com', hasPassword: false })
    // No password set → password login is refused.
    expect((await call('POST', '/api/auth/login', { email: 'dana@example.com', password: 'anything!!' })).statusCode).toBe(401)
  })

  it('rejects a duplicate email', async () => {
    expect((await call('PUT', `/api/persons/${dana}/login`, { email: 'wally@example.com', password: 'pwpwpwpw' }, admin)).statusCode).toBe(409)
  })

  it('removes a login and blocks removing the owner’s', async () => {
    expect((await call('DELETE', `/api/persons/${wally}/login`, undefined, admin)).statusCode).toBe(200)
    expect((await call('POST', '/api/auth/login', { email: 'wally@example.com', password: 'wallypass1' })).statusCode).toBe(401)
    // Owner is protected.
    expect((await call('DELETE', `/api/persons/${owner}/login`, undefined, admin)).statusCode).toBe(400)
  })
})
