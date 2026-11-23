import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { AddressInfo } from 'node:net'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let accessToken = ''

interface RunResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {}
): Promise<RunResult> {
  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    {
      httpMethod: method,
      path,
      headers,
      queryStringParameters: {},
      requestContext: { identity: { sourceIp: '203.0.113.10' } },
      body: body !== undefined ? JSON.stringify(body) : null,
      isBase64Encoded: false,
    },
    {}
  ) as Promise<RunResult>
}

const header = (result: RunResult, name: string) =>
  result.headers[name] ?? result.headers[name.toLowerCase()] ?? result.headers[name.toUpperCase()]

function expectLimited(result: RunResult): void {
  expect(result.statusCode).toBe(429)
  expect(Number(header(result, 'Retry-After'))).toBeGreaterThan(0)
  expect(JSON.parse(result.body)).toMatchObject({ error: 'TooManyRequests' })
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.RATE_LIMIT_SETUP_MAX = '2'
  process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = '2'
  process.env.RATE_LIMIT_LOGIN_IP_MAX = '20'
  process.env.RATE_LIMIT_OIDC_START_MAX = '2'
  process.env.RATE_LIMIT_OIDC_EXCHANGE_MAX = '2'
  process.env.RATE_LIMIT_REFRESH_MAX = '2'
  process.env.RATE_LIMIT_KIOSK_PAIR_MAX = '2'
  process.env.RATE_LIMIT_MEDIA_MAX = '2'
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'hunter2hunter' },
  })
  expect(setup.statusCode).toBe(201)
  accessToken = JSON.parse(setup.body).accessToken
}, 120_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('sensitive route throttling', () => {
  it('throttles repeated first-run setup requests', async () => {
    expect((await call('POST', '/api/auth/setup', {})).statusCode).toBe(409)
    expectLimited(await call('POST', '/api/auth/setup', {}))
  })

  it('throttles password guessing by normalized account email', async () => {
    const body = { email: 'TARGET@example.com', password: 'wrong-password' }
    expect((await call('POST', '/api/auth/login', body)).statusCode).toBe(401)
    expect((await call('POST', '/api/auth/login', { ...body, email: 'target@EXAMPLE.com' })).statusCode).toBe(401)
    expectLimited(await call('POST', '/api/auth/login', body))
  })

  it('throttles OIDC start and handoff exchange abuse', async () => {
    expect((await call('GET', '/api/auth/oidc/start')).statusCode).toBe(404)
    expect((await call('GET', '/api/auth/oidc/start')).statusCode).toBe(404)
    expectLimited(await call('GET', '/api/auth/oidc/start'))

    expect((await call('POST', '/api/auth/oidc/exchange', { code: 'bad-1' })).statusCode).toBe(401)
    expect((await call('POST', '/api/auth/oidc/exchange', { code: 'bad-2' })).statusCode).toBe(401)
    expectLimited(await call('POST', '/api/auth/oidc/exchange', { code: 'bad-3' }))
  })

  it('does not let spoofed forwarding headers rotate the trusted IP bucket', async () => {
    const refresh = { refreshToken: 'not-a-valid-refresh-token' }
    expect((await call('POST', '/api/auth/refresh', refresh, undefined, {
      'x-forwarded-for': '198.51.100.1',
    })).statusCode).toBe(401)
    expect((await call('POST', '/api/auth/refresh', refresh, undefined, {
      'x-forwarded-for': '198.51.100.2',
    })).statusCode).toBe(401)
    expectLimited(await call('POST', '/api/auth/refresh', refresh, undefined, {
      'x-forwarded-for': '198.51.100.3',
    }))
  })

  describe('over real HTTP with spoofed X-Forwarded-For', () => {
    async function refreshStatuses(trustProxy: boolean, ips: string[]): Promise<number[]> {
      const { createHttpServer, listen } = await import('../src/platform/http-server')
      const server = createHttpServer(app, { trustProxy })
      const { port } = (await listen(server, { port: 0, host: '127.0.0.1' })) as AddressInfo
      try {
        const statuses: number[] = []
        for (const ip of ips) {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
            body: JSON.stringify({ refreshToken: 'not-a-valid-refresh-token' }),
          })
          statuses.push(res.status)
        }
        return statuses
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    it('ignores X-Forwarded-For when TRUST_PROXY is unset', async () => {
      expect(await refreshStatuses(false, ['198.51.100.21', '198.51.100.22', '198.51.100.23'])).toEqual([401, 401, 429])
    })

    it('honours X-Forwarded-For when TRUST_PROXY=true', async () => {
      expect(await refreshStatuses(true, ['198.51.100.31', '198.51.100.32', '198.51.100.33'])).toEqual([401, 401, 401])
    })
  })

  it('throttles kiosk pairing-code guesses', async () => {
    expect((await call('POST', '/api/kiosk/pair', { code: 'BAD001' })).statusCode).toBe(401)
    expect((await call('POST', '/api/kiosk/pair', { code: 'BAD002' })).statusCode).toBe(401)
    expectLimited(await call('POST', '/api/kiosk/pair', { code: 'BAD003' }))
  })

  it('throttles repeated media upload attempts', async () => {
    const invalid = { contentType: 'text/plain', data: 'bm9wZQ==' }
    expect((await call('POST', '/api/media', invalid, accessToken)).statusCode).toBe(400)
    expect((await call('POST', '/api/media', invalid, accessToken)).statusCode).toBe(400)
    expectLimited(await call('POST', '/api/media', invalid, accessToken))
  })
})
