// Media upload endpoint — POST /api/media. Spins its own Postgres testcontainer +
// app, mirroring photos.integration.test.ts. MEDIA_DIR points at a temp dir so the
// local blob driver writes there; we assert the file lands on disk.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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

function call(method: string, path: string, token?: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders }
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
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')
const WEBP_B64 = Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary').toString('base64')

describe('POST /api/media', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('POST', '/api/media', mint('dev|nobody'), { data: PNG_B64, contentType: 'image/png' })).statusCode).toBe(403)
  })

  it('rejects a disallowed content type (400)', async () => {
    const res = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/gif' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects malformed base64 and bytes that do not match the declared image type', async () => {
    expect((await call('POST', '/api/media', kevin, { data: 'not-base64', contentType: 'image/png' })).statusCode).toBe(400)
    expect((await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/jpeg' })).statusCode).toBe(400)
  })

  it('rejects an oversize image (>10MB decoded) with 413', async () => {
    // 11 MB of zero bytes → base64
    const big = Buffer.alloc(11 * 1024 * 1024, 0).toString('base64')
    const res = await call('POST', '/api/media', kevin, { data: big, contentType: 'image/jpeg' })
    expect(res.statusCode).toBe(413)
  })

  it('accepts jpeg/png/webp and writes the file to disk', async () => {
    const samples: Record<string, string> = {
      'image/jpeg': JPEG_B64,
      'image/png': PNG_B64,
      'image/webp': WEBP_B64,
    }
    for (const [ct, data] of Object.entries(samples)) {
      const res = await call('POST', '/api/media', kevin, { data, contentType: ct })
      expect(res.statusCode).toBe(201)
      const out = JSON.parse(res.body) as { key: string; url: string; contentType: string }
      expect(out.contentType).toBe(ct)
      expect(out.url).toMatch(new RegExp(`^/media/${out.key}\\?expires=\\d{10}&sig=[A-Za-z0-9_-]{43}$`))
      // The file exists and contains the decoded bytes.
      const onDisk = await readFile(join(mediaDir, out.key))
      expect(Buffer.compare(onDisk, Buffer.from(data, 'base64'))).toBe(0)
      await stat(join(mediaDir, out.key)) // throws if missing
    }
  })

  it('authorizes only an unmodified, signed media URL', async () => {
    const upload = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/png' })
    const out = JSON.parse(upload.body) as { key: string; url: string }

    expect((await call('GET', '/api/media/authorize', undefined, undefined, { 'x-forwarded-uri': out.url })).statusCode).toBe(200)
    expect((await call('GET', '/api/media/authorize', undefined, undefined, { 'x-forwarded-uri': `/media/${out.key}` })).statusCode).toBe(403)
    expect((await call('GET', '/api/media/authorize', undefined, undefined, { 'x-forwarded-uri': `${out.url}x` })).statusCode).toBe(403)
    expect((await call('GET', '/api/media/authorize')).statusCode).toBe(403)
  })
})

describe('parent reads renew uploaded media', () => {
  async function upload() {
    const response = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/png' })
    expect(response.statusCode).toBe(201)
    return JSON.parse(response.body) as { key: string; url: string }
  }
  const authorized = (path: string) => call('GET', '/api/media/authorize', undefined, undefined, { 'x-forwarded-uri': path })

  it.each(['pantry', 'recipes'])('%s emits a different valid signature after the upload URL expires', async (resource) => {
    await call('PATCH', '/api/household/modules', kevin, { pantry: true })
    const image = await upload()
    const created = await call('POST', `/api/${resource}`, kevin, { name: 'Uploaded pantry photo', title: 'Uploaded recipe photo', storageKey: image.key })
    expect(created.statusCode).toBe(201)
    const entity = JSON.parse(created.body)[resource === 'pantry' ? 'item' : 'recipe']
    expect(entity.imageUrl).toBe(image.url)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 601_000)
    try {
      expect((await authorized(image.url)).statusCode).toBe(403)
      const response = await call('GET', resource === 'pantry' ? '/api/pantry' : `/api/recipes/${entity.id}`, kevin)
      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      const fresh = resource === 'pantry' ? body.items.find((i: { id: string }) => i.id === entity.id) : body.recipe
      expect(fresh.imageUrl).not.toBe(image.url)
      expect((await authorized(fresh.imageUrl)).statusCode).toBe(200)
    } finally { clock.mockRestore() }
  })

  it('normalizes older pantry clients saving a signed URL to its stable storage key', async () => {
    const image = await upload()
    const item = JSON.parse((await call('POST', '/api/pantry', kevin, { name: 'Legacy upload', imageUrl: image.url })).body).item
    const { query } = await import('../src/platform/db')
    const stored = await query('select storage_key,image_url from pantry_items where id=$1', [item.id])
    expect(stored.rows[0]).toEqual({ storage_key: image.key, image_url: null })
  })

  it('backfills owned legacy pantry URLs, including custom media paths, without changing CDN images', async () => {
    const image = await upload()
    const householdId = image.key.split('/')[0]
    const migration = await readFile('migrations/0102_pantry_media_storage.sql', 'utf8')
    const [up, down] = migration.split('-- Down Migration')
    const { getPool } = await import('../src/platform/db')
    const client = await getPool().connect()
    try {
      await client.query('begin')
      await client.query(down)
      const legacy = [`/media/${image.key}`, image.url, `https://previous.example/uploads/${image.key}?expires=1&sig=old`]
      const ids: string[] = []
      for (const url of legacy) {
        const result = await client.query('insert into pantry_items (household_id,name,location,image_url) values ($1,$2,$3,$4) returning id', [householdId, 'Legacy migration', 'Pantry', url])
        ids.push(result.rows[0].id)
      }
      const external = 'https://images.openfoodfacts.org/images/products/external.jpg'
      const cdn = await client.query('insert into pantry_items (household_id,name,location,image_url) values ($1,$2,$3,$4) returning id', [householdId, 'CDN migration', 'Pantry', external])
      await client.query(up)
      const migrated = await client.query('select storage_key,image_url from pantry_items where id=any($1::uuid[])', [ids])
      expect(migrated.rows).toEqual(legacy.map(() => ({ storage_key: image.key, image_url: null })))
      const untouched = await client.query('select storage_key,image_url from pantry_items where id=$1', [cdn.rows[0].id])
      expect(untouched.rows[0]).toEqual({ storage_key: null, image_url: external })
    } finally { await client.query('rollback'); client.release() }
  })

  it('rejects another household storage key on pantry create and update', async () => {
    const foreignKey = '11111111-1111-4111-8111-111111111111/0123456789abcdef0123456789abcdef.png'
    expect((await call('POST', '/api/pantry', kevin, { name: 'Foreign image', storageKey: foreignKey })).statusCode).toBe(400)
    const item = JSON.parse((await call('POST', '/api/pantry', kevin, { name: 'Keep local' })).body).item
    expect((await call('PATCH', `/api/pantry/${item.id}`, kevin, { storageKey: foreignKey })).statusCode).toBe(400)
    expect((await call('PATCH', `/api/pantry/${item.id}`, kevin, { imageUrl: `/media/${foreignKey}?expires=1&sig=old` })).statusCode).toBe(400)
  })

  it('keeps external pantry URLs intact and clears an uploaded photo when replaced or removed', async () => {
    const image = await upload()
    const item = JSON.parse((await call('POST', '/api/pantry', kevin, { name: 'External replacement', storageKey: image.key })).body).item
    const external = 'https://images.openfoodfacts.org/images/products/example.jpg'
    const replaced = await call('PATCH', `/api/pantry/${item.id}`, kevin, { imageUrl: external })
    expect(JSON.parse(replaced.body).item.imageUrl).toBe(external)
    const { query } = await import('../src/platform/db')
    expect((await query('select storage_key from pantry_items where id=$1', [item.id])).rows[0].storage_key).toBeNull()
    await call('PATCH', `/api/pantry/${item.id}`, kevin, { storageKey: image.key })
    const removed = await call('PATCH', `/api/pantry/${item.id}`, kevin, { storageKey: null })
    expect(JSON.parse(removed.body).item.imageUrl).toBeNull()
  })
})
