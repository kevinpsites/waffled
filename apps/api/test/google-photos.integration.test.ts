// Google Photos import: connect via OAuth, then pick photos through the Photos
// Picker API into a named Waffled album. Exercised against an in-process stub
// standing in for Google's token/userinfo endpoints, the Picker sessions +
// mediaItems endpoints, and the image bytes behind each baseUrl.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'

let pg: StartedPostgreSqlContainer
let stub: Server
let stubPort = 0
let mediaDir = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>
let householdId = ''

interface StubSession { id: string; picked: boolean; expired: boolean; deleted: boolean; items: unknown[] }
const sessions = new Map<string, StubSession>()
let sessionSeq = 0
let refreshGrants = 0
let lastPickerAuth = ''
let nextItems: unknown[] = []
let pickerDisabled = false

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult { statusCode: number; body: string; headers?: Record<string, string> }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    queryStringParameters[k] = decodeURIComponent(v ?? '')
  }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)

const kevin = mint('dev|kevin')
const kidToken = mint('dev|kid')

function photoItem(id: string, createTime = '2024-07-04T15:00:00Z') {
  return {
    id,
    createTime,
    type: 'PHOTO',
    mediaFile: { baseUrl: `http://127.0.0.1:${stubPort}/img/${id}`, mimeType: 'image/jpeg', filename: `${id}.jpg` },
  }
}
function videoItem(id: string) {
  return { id, createTime: '2024-07-04T15:00:00Z', type: 'VIDEO', mediaFile: { baseUrl: `http://127.0.0.1:${stubPort}/img/${id}`, mimeType: 'video/mp4', filename: `${id}.mp4` } }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])

function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://stub')
      const path = u.pathname
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.method === 'POST' && path === '/token') {
          const form = new URLSearchParams(raw)
          if (form.get('grant_type') === 'refresh_token') {
            refreshGrants++
            res.end(JSON.stringify({ access_token: `access-r${refreshGrants}`, expires_in: 3599, scope: PICKER_SCOPE }))
          } else {
            res.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599, scope: `openid email ${PICKER_SCOPE}` }))
          }
          return
        }
        if (path === '/userinfo') {
          res.end(JSON.stringify({ sub: 'google-sub-photos', email: 'kevin@example.com' }))
          return
        }
        if (path.startsWith('/v1/')) lastPickerAuth = String(req.headers.authorization ?? '')
        if (req.method === 'POST' && path === '/v1/sessions' && pickerDisabled) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Photos Picker API has not been used in project 123 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=123' } }] } }))
          return
        }
        if (req.method === 'POST' && path === '/v1/sessions') {
          const id = `sess-${++sessionSeq}`
          sessions.set(id, { id, picked: false, expired: false, deleted: false, items: nextItems })
          res.end(JSON.stringify({
            id,
            pickerUri: `https://photos.google.com/picker/${id}`,
            pollingConfig: { pollInterval: '3s', timeoutIn: '1800s' },
            expireTime: new Date(Date.now() + 3600_000).toISOString(),
            mediaItemsSet: false,
          }))
          return
        }
        const sm = path.match(/^\/v1\/sessions\/([^/]+)$/)
        if (sm) {
          const s = sessions.get(sm[1])
          if (!s || s.deleted) { res.statusCode = 404; res.end('{}'); return }
          if (req.method === 'DELETE') { s.deleted = true; res.end('{}'); return }
          if (s.expired) { res.statusCode = 404; res.end(JSON.stringify({ error: { status: 'NOT_FOUND' } })); return }
          res.end(JSON.stringify({ id: s.id, pickerUri: `https://photos.google.com/picker/${s.id}`, mediaItemsSet: s.picked }))
          return
        }
        if (path === '/v1/mediaItems') {
          const s = sessions.get(u.searchParams.get('sessionId') ?? '')
          if (!s || !s.picked) { res.statusCode = 400; res.end('{}'); return }
          // Two-item pages so the importer has to follow nextPageToken.
          const start = Number(u.searchParams.get('pageToken') ?? '0')
          const page = s.items.slice(start, start + 2)
          const more = start + 2 < s.items.length
          res.end(JSON.stringify({ mediaItems: page, ...(more ? { nextPageToken: String(start + 2) } : {}) }))
          return
        }
        if (path.startsWith('/img/')) {
          if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) { res.statusCode = 401; res.end(); return }
          if (!path.endsWith('=w2560-h2560')) { res.statusCode = 400; res.end(); return }
          res.setHeader('content-type', 'image/jpeg')
          res.end(JPEG)
          return
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

async function connect(): Promise<void> {
  const url = json(await call('POST', '/api/photos/google/connect', kevin, {})).url
  const state = new URL(url).searchParams.get('state')
  const cb = await call('GET', `/auth/google/photos/callback?code=code-1&state=${state}`)
  expect(cb.statusCode).toBe(200)
}

async function waitForImport(id: string) {
  for (let i = 0; i < 50; i++) {
    const imp = json(await call('GET', `/api/photos/google/imports/${id}`, kevin)).import
    if (imp.status !== 'picking' && imp.status !== 'importing') return imp
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('import never finished')
}

async function pick(album: string, items: unknown[]) {
  nextItems = items
  const res = await call('POST', '/api/photos/google/imports', kevin, { album })
  expect(res.statusCode).toBe(201)
  const { import: imp } = json(res)
  sessions.get(imp.sessionId)!.picked = true
  return waitForImport(imp.id)
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)
  stubPort = await startStub()
  mediaDir = mkdtempSync(join(tmpdir(), 'waffled-gphotos-'))

  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.MEDIA_DIR = mediaDir
  delete process.env.STORAGE_DRIVER
  process.env.GOOGLE_CLIENT_ID = 'client-abc'
  process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz'
  process.env.GOOGLE_PHOTOS_REDIRECT_URI = 'http://localhost:8080/auth/google/photos/callback'
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${stubPort}/token`
  process.env.GOOGLE_USERINFO_URL = `http://127.0.0.1:${stubPort}/userinfo`
  process.env.GOOGLE_PHOTOS_PICKER_API_BASE = `http://127.0.0.1:${stubPort}/v1`
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  const db = await import('../src/platform/db')
  closePool = db.closePool
  query = db.query

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const sb = json(setup)
  householdId = sb.household.id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, sb.person.id]
  )
  const kid = await query(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Kid','child',false) returning id`,
    [householdId]
  )
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kid',true)`,
    [householdId, kid.rows[0].id]
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

beforeEach(() => {
  nextItems = []
})

describe('connect', () => {
  it('reports not-connected before any account exists', async () => {
    const res = await call('GET', '/api/photos/google/status', kevin)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ configured: true, account: null, imports: [] })
  })

  it('refuses to start an import before connecting', async () => {
    expect((await call('POST', '/api/photos/google/imports', kevin, { album: 'Beach' })).statusCode).toBe(409)
  })

  it('403s connect for a non-admin', async () => {
    expect((await call('POST', '/api/photos/google/connect', kidToken, {})).statusCode).toBe(403)
  })

  it('returns a consent URL asking only for the picker scope, on the photos redirect', async () => {
    const res = await call('POST', '/api/photos/google/connect', kevin, {})
    expect(res.statusCode).toBe(200)
    const url = new URL(json(res).url)
    expect(url.searchParams.get('scope')).toContain(PICKER_SCOPE)
    expect(url.searchParams.get('scope')).not.toContain('calendar')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/auth/google/photos/callback')
    expect(url.searchParams.get('access_type')).toBe('offline')
  })

  it('rejects an unknown state on the callback', async () => {
    expect((await call('GET', '/auth/google/photos/callback?code=x&state=nope')).statusCode).toBe(400)
  })

  it('stores the account with the refresh token encrypted at rest', async () => {
    await connect()
    const { rows } = await query(`select email, refresh_token_encrypted from google_photos_accounts where household_id = $1`, [householdId])
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('kevin@example.com')
    expect(rows[0].refresh_token_encrypted).not.toContain('refresh-1')
    const status = json(await call('GET', '/api/photos/google/status', kevin))
    expect(status.account).toMatchObject({ email: 'kevin@example.com' })
  })
})

describe('import', () => {
  it('creates a picker session and stays picking until the user selects', async () => {
    const res = await call('POST', '/api/photos/google/imports', kevin, { album: '  Beach  ' })
    expect(res.statusCode).toBe(201)
    const imp = json(res).import
    expect(imp).toMatchObject({ album: 'Beach', status: 'picking' })
    expect(imp.pickerUri).toMatch(/^https:\/\/photos\.google\.com\/picker\//)

    const polled = json(await call('GET', `/api/photos/google/imports/${imp.id}`, kevin)).import
    expect(polled.status).toBe('picking')
  })

  it('explains how to fix a disabled Picker API instead of a bare 502', async () => {
    pickerDisabled = true
    try {
      const res = await call('POST', '/api/photos/google/imports', kevin, { album: 'Beach' })
      expect(res.statusCode).toBe(502)
      expect(json(res)).toMatchObject({
        error: 'PickerApiDisabled',
        enableUrl: 'https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview?project=123',
      })
      expect(json(res).message).toMatch(/Photos Picker API/)
    } finally {
      pickerDisabled = false
    }
  })

  it('requires an album name', async () => {
    expect((await call('POST', '/api/photos/google/imports', kevin, { album: '   ' })).statusCode).toBe(400)
  })

  it('403s an import for a non-admin', async () => {
    expect((await call('POST', '/api/photos/google/imports', kidToken, { album: 'Beach' })).statusCode).toBe(403)
  })

  it('downloads picked photos into the album, skips videos, and deletes the session', async () => {
    const imp = await pick('Beach', [photoItem('p1', '2024-07-04T15:00:00Z'), videoItem('v1'), photoItem('p2'), photoItem('p3')])
    expect(imp).toMatchObject({ status: 'done', importedCount: 3, skippedCount: 1 })
    expect(sessions.get(imp.sessionId)!.deleted).toBe(true)

    const photos = json(await call('GET', '/api/photos?memory=Beach', kevin)).photos
    expect(photos).toHaveLength(3)
    for (const p of photos) {
      expect(p.imageUrl).toMatch(/^\/media\//)
      expect(existsSync(join(mediaDir, p.imageUrl.replace(/^\/media\//, '')))).toBe(true)
    }
    expect(photos.map((p: { takenAt: string }) => new Date(p.takenAt).toISOString())).toContain('2024-07-04T15:00:00.000Z')
  })

  it('does not duplicate photos picked again into the same household', async () => {
    const imp = await pick('Kids', [photoItem('p1'), photoItem('k1')])
    expect(imp).toMatchObject({ status: 'done', importedCount: 1, skippedCount: 1 })
    expect(json(await call('GET', '/api/photos?memory=Kids', kevin)).photos).toHaveLength(1)
  })

  it('marks the import expired when the session lapses before anything is picked', async () => {
    const imp = json(await call('POST', '/api/photos/google/imports', kevin, { album: 'Late' })).import
    sessions.get(imp.sessionId)!.expired = true
    const polled = json(await call('GET', `/api/photos/google/imports/${imp.id}`, kevin)).import
    expect(polled.status).toBe('expired')
  })

  it('refreshes an expired access token before calling the picker', async () => {
    await query(`update google_photos_accounts set access_token_expires_at = now() - interval '1 minute' where household_id = $1`, [householdId])
    const before = refreshGrants
    const res = await call('POST', '/api/photos/google/imports', kevin, { album: 'Fresh' })
    expect(res.statusCode).toBe(201)
    expect(refreshGrants).toBe(before + 1)
    expect(lastPickerAuth).toBe(`Bearer access-r${refreshGrants}`)
  })

  it('summarises each imported album with its photo count and last sync time', async () => {
    const status = json(await call('GET', '/api/photos/google/status', kevin))
    expect(status.photoCount).toBe(4)
    const beach = status.albums.find((a: { name: string }) => a.name === 'Beach')
    expect(beach).toMatchObject({ name: 'Beach', photoCount: 3 })
    expect(new Date(beach.lastSyncedAt).getTime()).toBeGreaterThan(0)
    expect(status.albums.find((a: { name: string }) => a.name === 'Kids')).toMatchObject({ photoCount: 1 })
  })

  it('lists recent imports in the status', async () => {
    const status = json(await call('GET', '/api/photos/google/status', kevin))
    expect(status.imports.map((i: { album: string }) => i.album)).toEqual(expect.arrayContaining(['Beach', 'Kids']))
  })

  it('404s an import from another household or a bad id', async () => {
    expect((await call('GET', '/api/photos/google/imports/not-a-uuid', kevin)).statusCode).toBe(404)
    expect((await call('GET', '/api/photos/google/imports/00000000-0000-4000-8000-000000000000', kevin)).statusCode).toBe(404)
  })
})

describe('disconnect', () => {
  it('removes the account, every imported photo and its file, and the albums from the mix', async () => {
    // An uploaded photo in the same album must survive; a Google album in the mix must not.
    await call('POST', '/api/photos', kevin, { caption: 'Mine', emoji: '🏖️', memory: 'Beach' })
    await call('PUT', '/api/kiosk/display', kevin, { photoSource: 'albums', photoAlbums: ['Beach', 'Kids', 'Uploads'] })
    await call('POST', '/api/photos', kevin, { caption: 'Up', emoji: '📷', memory: 'Uploads' })
    const files = json(await call('GET', '/api/photos?memory=Kids', kevin)).photos.map((p: { imageUrl: string }) => join(mediaDir, p.imageUrl.replace(/^\/media\//, '')))
    expect(files.every(existsSync)).toBe(true)

    const status = json(await call('GET', '/api/photos/google/status', kevin))
    expect((await call('DELETE', `/api/photos/google/accounts/${status.account.id}`, kidToken)).statusCode).toBe(403)
    const res = await call('DELETE', `/api/photos/google/accounts/${status.account.id}`, kevin)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ removedPhotos: 4 })

    const after = json(await call('GET', '/api/photos/google/status', kevin))
    expect(after).toMatchObject({ account: null, imports: [], albums: [], photoCount: 0 })
    expect(json(await call('GET', '/api/photos?memory=Beach', kevin)).photos.map((p: { caption: string }) => p.caption)).toEqual(['Mine'])
    expect(json(await call('GET', '/api/photos?memory=Kids', kevin)).photos).toHaveLength(0)
    expect(files.some(existsSync)).toBe(false)
    // Beach still has an uploaded photo; Kids is gone entirely.
    expect(json(await call('GET', '/api/kiosk/display', kevin)).photoAlbums).toEqual(['Beach', 'Uploads'])
  })

  it('can reconnect and re-import the same photos after a disconnect', async () => {
    await connect()
    const imp = await pick('Beach', [photoItem('p1'), photoItem('p2')])
    expect(imp).toMatchObject({ status: 'done', importedCount: 2, skippedCount: 0 })
  })
})
