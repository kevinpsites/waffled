// Media upload endpoint — POST /api/media. Spins its own Postgres testcontainer +
// app, mirroring photos.integration.test.ts. MEDIA_DIR points at a temp dir so the
// local blob driver writes there; we assert the file lands on disk.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let mediaDir = ''

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
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

let kevin = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  mediaDir = join(tmpdir(), `waffled-media-it-${randomBytes(8).toString('hex')}`)
  process.env.MEDIA_DIR = mediaDir
  delete process.env.STORAGE_DRIVER
  delete process.env.MEDIA_BASE_URL
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
  await rm(mediaDir, { recursive: true, force: true })
})

// A 1x1 PNG, base64. Tiny but real bytes.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('POST /api/media', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('POST', '/api/media', mint('dev|nobody'), { data: PNG_B64, contentType: 'image/png' })).statusCode).toBe(403)
  })

  it('rejects a disallowed content type (400)', async () => {
    const res = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/gif' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an oversize image (>10MB decoded) with 413', async () => {
    // 11 MB of zero bytes → base64
    const big = Buffer.alloc(11 * 1024 * 1024, 0).toString('base64')
    const res = await call('POST', '/api/media', kevin, { data: big, contentType: 'image/jpeg' })
    expect(res.statusCode).toBe(413)
  })

  it('accepts jpeg/png/webp and writes the file to disk', async () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp']) {
      const res = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: ct })
      expect(res.statusCode).toBe(201)
      const out = JSON.parse(res.body) as { key: string; url: string; contentType: string }
      expect(out.contentType).toBe(ct)
      expect(out.url).toBe(`/media/${out.key}`)
      // The file exists and contains the decoded bytes.
      const onDisk = await readFile(join(mediaDir, out.key))
      expect(Buffer.compare(onDisk, Buffer.from(PNG_B64, 'base64'))).toBe(0)
      await stat(join(mediaDir, out.key)) // throws if missing
    }
  })
})
