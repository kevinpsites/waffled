// Shared harness for the /mcp suites: boots the real app against an isolated Postgres,
// sets up one household (owner Kevin, signed in via a dev JWT) and drives JSON-RPC
// through app.run — the same path a real MCP client takes.
import { expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './pg'
import { runMigrations } from '../../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

export interface RunResult {
  statusCode: number
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  body: string
}

export function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
export const keyed = (k: string) => ({ 'x-api-key': k })
export const json = (r: RunResult) => JSON.parse(r.body)

export function header(r: RunResult, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(r.headers ?? {})) if (k.toLowerCase() === lower) return v
  for (const [k, v] of Object.entries(r.multiValueHeaders ?? {})) if (k.toLowerCase() === lower) return v.join(', ')
  return undefined
}

export interface McpHarness {
  householdId: string
  ownerId: string
  owner: string
  run(method: string, path: string, headers: Record<string, string>, body?: unknown, raw?: string, qs?: Record<string, string>): Promise<RunResult>
  call(method: string, path: string, token?: string, body?: unknown): Promise<RunResult>
  rpc(headers: Record<string, string>, method: string, params?: unknown, id?: number | string): Promise<RunResult>
  // tools/call → the JSON-RPC `result` (a tool result, possibly isError).
  tool(headers: Record<string, string>, name: string, args?: unknown): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: any }>
  mintKey(token: string, name: string, scopes: string[]): Promise<string>
  // Adds a member with a sign-in identity; returns their id and a session token.
  addMember(name: string, memberType: 'adult' | 'teen' | 'kid'): Promise<{ id: string; token: string }>
  sql<T = any>(text: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

export async function startMcpHarness(): Promise<McpHarness> {
  const pg: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  delete process.env.PUBLIC_BASE_URL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = (await import('../../src/app')).default
  const db = await import('../../src/platform/db')

  const run: McpHarness['run'] = (method, path, headers, body, raw, qs) => {
    const h: Record<string, string> = { ...headers }
    if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json'
    return app.run(
      {
        httpMethod: method,
        path,
        headers: h,
        queryStringParameters: qs ?? {},
        body: raw ?? (body !== undefined ? JSON.stringify(body) : null),
        isBase64Encoded: false,
      },
      {}
    )
  }
  const call: McpHarness['call'] = (method, path, token, body) => {
    const [p, q] = path.split('?')
    const qs: Record<string, string> = {}
    if (q) for (const pair of q.split('&')) {
      const [k, v] = pair.split('=')
      qs[k] = decodeURIComponent(v ?? '')
    }
    return run(method, p, token ? bearer(token) : {}, body, undefined, qs)
  }
  const rpc: McpHarness['rpc'] = (headers, method, params, id = 1) =>
    run('POST', '/mcp', headers, { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
  const tool: McpHarness['tool'] = async (headers, name, args = {}) => {
    const res = await rpc(headers, 'tools/call', { name, arguments: args })
    expect(res.statusCode).toBe(200)
    const body = json(res)
    expect(body.error, JSON.stringify(body.error)).toBeUndefined()
    return body.result
  }
  const sql: McpHarness['sql'] = async (text, params) => (await db.query(text, params as unknown[])).rows as never

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const householdId: string = json(setup).household.id
  const ownerId: string = json(setup).person.id
  await sql(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )

  const mintKey: McpHarness['mintKey'] = async (token, name, scopes) => {
    const res = await call('POST', '/api/api-keys', token, { name, scopes })
    expect(res.statusCode).toBe(201)
    return json(res).key as string
  }
  const addMember: McpHarness['addMember'] = async (name, memberType) => {
    const [p] = await sql<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin) values ($1,$2,$3,false) returning id`,
      [householdId, name, memberType]
    )
    const sub = `dev|${name.toLowerCase()}`
    await sql(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password',$3,true)`,
      [householdId, p.id, sub]
    )
    return { id: p.id, token: mint(sub) }
  }

  return {
    householdId,
    ownerId,
    owner: mint('dev|kevin'),
    run,
    call,
    rpc,
    tool,
    mintKey,
    addMember,
    sql,
    async close() {
      await db.closePool()
      await pg.stop()
    },
  }
}
