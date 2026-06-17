// Weather endpoint (6.8): geocodes the household location + fetches current
// conditions from Open-Meteo, against an in-process stub. Covers the unconfigured
// case, a full lookup (code→label/emoji, rounding), and forecast caching.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let stub: Server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let geocodeCalls = 0
let forecastCalls = 0

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}
const kevin = mint('dev|kevin')

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://stub')
      res.setHeader('content-type', 'application/json')
      if (u.pathname === '/geocode') {
        geocodeCalls++
        res.end(JSON.stringify({ results: [{ latitude: 30.27, longitude: -97.74, name: 'Austin', admin1: 'Texas' }] }))
      } else if (u.pathname === '/forecast') {
        forecastCalls++
        res.end(JSON.stringify({ current: { temperature_2m: 78.4, weather_code: 2, is_day: 1 } }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)
  const port = await startStub()
  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.OPEN_METEO_GEOCODE_URL = `http://127.0.0.1:${port}/geocode`
  process.env.OPEN_METEO_FORECAST_URL = `http://127.0.0.1:${port}/forecast`

  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('weather', () => {
  it('returns configured:false when no location is set', async () => {
    const res = await call('GET', '/api/weather', kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })

  it('geocodes the location and returns current conditions', async () => {
    await call('PATCH', '/api/household', kevin, { location: 'Austin, TX' })
    const res = await call('GET', '/api/weather', kevin)
    const w = JSON.parse(res.body)
    expect(w).toMatchObject({ configured: true, tempF: 78, code: 2, label: 'Partly cloudy', emoji: '⛅', location: 'Austin, Texas' })
  })

  it('caches the forecast (no extra Open-Meteo calls on the next read)', async () => {
    const g = geocodeCalls
    const f = forecastCalls
    await call('GET', '/api/weather', kevin)
    expect(forecastCalls).toBe(f) // served from cache
    expect(geocodeCalls).toBe(g) // geocode cached too
  })
})
