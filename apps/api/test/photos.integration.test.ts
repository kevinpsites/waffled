// Photos domain — migration + api. Spins its own Postgres testcontainer + app,
// mirroring goals.integration.test.ts. Photos are household-scoped + soft-deleted;
// a photo is either an image URL or an emoji + color tile (no blob storage yet).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''
let mediaDir = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
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
  if (qs)
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=')
      queryStringParameters[k] = decodeURIComponent(v ?? '')
    }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  mediaDir = join(tmpdir(), `nook-photos-it-${randomBytes(8).toString('hex')}`)
  process.env.MEDIA_DIR = mediaDir
  delete process.env.STORAGE_DRIVER
  delete process.env.MEDIA_BASE_URL
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const h = await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
  kevinId = JSON.parse(h.body).person.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
  await rm(mediaDir, { recursive: true, force: true })
})

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe('photos schema', () => {
  it('creates the photos table with the expected columns', async () => {
    const res = await withClient((c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema='public' and table_name='photos'`
      )
    )
    const cols = res.rows.map((r) => r.column_name)
    for (const col of ['image_url', 'caption', 'emoji', 'color_hex', 'memory', 'taken_at', 'uploaded_by', 'deleted_at', 'updated_at']) {
      expect(cols).toContain(col)
    }
  })

  it('bumps updated_at via the trigger', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name,timezone) values ('P','UTC') returning id`)
      const hid = h.rows[0].id
      const p = await c.query<{ id: string; updated_at: string }>(
        `insert into photos (household_id, caption, emoji, color_hex) values ($1,'X','🏖️','#7fc1e8') returning id, updated_at`,
        [hid]
      )
      const before = p.rows[0].updated_at
      await c.query(`update photos set caption='Y' where id=$1`, [p.rows[0].id])
      const after = await c.query<{ updated_at: string }>(`select updated_at from photos where id=$1`, [p.rows[0].id])
      expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
    })
  })
})

describe('photos api', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/photos', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('validates create input (400)', async () => {
    expect((await call('POST', '/api/photos', kevin, {})).statusCode).toBe(400)
    // caption present but neither imageUrl nor emoji
    expect((await call('POST', '/api/photos', kevin, { caption: 'No tile' })).statusCode).toBe(400)
  })

  it('creates with a blank/omitted caption (caption is optional)', async () => {
    const res = await call('POST', '/api/photos', kevin, { emoji: '🌅', colorHex: '#f6c24f' })
    expect(res.statusCode).toBe(201)
    const id = JSON.parse(res.body).photo.id
    const got = JSON.parse((await call('GET', `/api/photos/${id}`, kevin)).body).photo
    expect(got.caption).toBe('')
  })

  it('creates an emoji-tile photo and an image photo, lists newest-first', async () => {
    const tile = await call('POST', '/api/photos', kevin, {
      caption: 'Beach day',
      emoji: '🏖️',
      colorHex: '#7fc1e8',
      memory: 'Lake Day',
      takenAt: '2026-05-31T15:00:00Z',
      uploadedBy: kevinId,
    })
    expect(tile.statusCode).toBe(201)
    const tileId = JSON.parse(tile.body).photo.id

    const img = await call('POST', '/api/photos', kevin, {
      caption: 'Soccer win',
      imageUrl: 'https://example.com/soccer.jpg',
      takenAt: '2026-06-01T10:00:00Z',
    })
    expect(img.statusCode).toBe(201)
    const imgId = JSON.parse(img.body).photo.id

    const photos = JSON.parse((await call('GET', '/api/photos', kevin)).body).photos
    // newest taken_at first → soccer (Jun 1) before beach (May 31)
    const idx = (id: string) => photos.findIndex((p: { id: string }) => p.id === id)
    expect(idx(imgId)).toBeLessThan(idx(tileId))

    const beach = photos.find((p: { id: string }) => p.id === tileId)
    expect(beach).toMatchObject({ caption: 'Beach day', emoji: '🏖️', colorHex: '#7fc1e8', memory: 'Lake Day', imageUrl: null })
    expect(beach.uploadedBy).toMatchObject({ name: 'Kevin' })

    const soccer = photos.find((p: { id: string }) => p.id === imgId)
    expect(soccer).toMatchObject({ caption: 'Soccer win', imageUrl: 'https://example.com/soccer.jpg', emoji: null })
  })

  it('filters by memory', async () => {
    await call('POST', '/api/photos', kevin, { caption: 'Recital', emoji: '🩰', colorHex: '#e58ab0', memory: 'Recital night' })
    const lake = JSON.parse((await call('GET', '/api/photos?memory=Lake%20Day', kevin)).body).photos
    expect(lake.length).toBeGreaterThan(0)
    expect(lake.every((p: { memory: string }) => p.memory === 'Lake Day')).toBe(true)
  })

  it('fetches a single photo and 404s on unknown / bad ids', async () => {
    const add = await call('POST', '/api/photos', kevin, { caption: 'One', emoji: '🎂', colorHex: '#f6c24f' })
    const id = JSON.parse(add.body).photo.id
    const got = JSON.parse((await call('GET', `/api/photos/${id}`, kevin)).body).photo
    expect(got).toMatchObject({ caption: 'One', emoji: '🎂' })
    expect((await call('GET', '/api/photos/00000000-0000-0000-0000-000000000000', kevin)).statusCode).toBe(404)
    expect((await call('GET', '/api/photos/not-a-uuid', kevin)).statusCode).toBe(404)
  })

  it('soft-deletes a photo', async () => {
    const add = await call('POST', '/api/photos', kevin, { caption: 'Temp', emoji: '🥞', colorHex: '#f5c98a' })
    const id = JSON.parse(add.body).photo.id
    expect((await call('DELETE', `/api/photos/${id}`, kevin)).statusCode).toBe(204)
    const photos = JSON.parse((await call('GET', '/api/photos', kevin)).body).photos
    expect(photos.some((p: { id: string }) => p.id === id)).toBe(false)
    expect((await call('DELETE', `/api/photos/${id}`, kevin)).statusCode).toBe(404)
  })

  it('patches caption, memory (un-album via ""), and isFavorite', async () => {
    const add = await call('POST', '/api/photos', kevin, {
      caption: 'Before',
      emoji: '📸',
      colorHex: '#aabbcc',
      memory: 'Trip',
    })
    const id = JSON.parse(add.body).photo.id

    // caption → reflected in GET
    const capRes = await call('PATCH', `/api/photos/${id}`, kevin, { caption: 'After' })
    expect(capRes.statusCode).toBe(200)
    expect(JSON.parse(capRes.body).photo.caption).toBe('After')
    expect(JSON.parse((await call('GET', `/api/photos/${id}`, kevin)).body).photo.caption).toBe('After')

    // memory → a value, then "" → null
    const memSet = await call('PATCH', `/api/photos/${id}`, kevin, { memory: 'Lake Day' })
    expect(JSON.parse(memSet.body).photo.memory).toBe('Lake Day')
    const memClear = await call('PATCH', `/api/photos/${id}`, kevin, { memory: '' })
    expect(JSON.parse(memClear.body).photo.memory).toBeNull()

    // isFavorite → true
    const fav = await call('PATCH', `/api/photos/${id}`, kevin, { isFavorite: true })
    expect(JSON.parse(fav.body).photo.isFavorite).toBe(true)
  })

  it('clears the caption on a blank patch (caption is optional)', async () => {
    const add = await call('POST', '/api/photos', kevin, { caption: 'Clear me', emoji: '🐶', colorHex: '#cccccc' })
    const id = JSON.parse(add.body).photo.id
    const res = await call('PATCH', `/api/photos/${id}`, kevin, { caption: '   ' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).photo.caption).toBe('')
  })

  it('404s patching unknown / bad ids', async () => {
    expect((await call('PATCH', '/api/photos/00000000-0000-0000-0000-000000000000', kevin, { caption: 'x' })).statusCode).toBe(404)
    expect((await call('PATCH', '/api/photos/not-a-uuid', kevin, { caption: 'x' })).statusCode).toBe(404)
  })

  it('stores an uploaded image (storageKey) and resolves imageUrl to a /media URL; delete drops the blob', async () => {
    // Upload a blob via /api/media, then attach it to a photo.
    const up = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/png' })
    expect(up.statusCode).toBe(201)
    const { key } = JSON.parse(up.body) as { key: string }
    // The blob is on disk after upload.
    await stat(join(mediaDir, key))

    const add = await call('POST', '/api/photos', kevin, {
      caption: 'Uploaded shot',
      storageKey: key,
      contentType: 'image/png',
    })
    expect(add.statusCode).toBe(201)
    const id = JSON.parse(add.body).photo.id

    const got = JSON.parse((await call('GET', `/api/photos/${id}`, kevin)).body).photo
    expect(got.imageUrl).toBe(`/media/${key}`)

    // Deleting the photo best-effort removes the backing blob.
    expect((await call('DELETE', `/api/photos/${id}`, kevin)).statusCode).toBe(204)
    await expect(stat(join(mediaDir, key))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
