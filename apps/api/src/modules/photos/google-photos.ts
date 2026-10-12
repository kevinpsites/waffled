// Google Photos import. An admin connects a Google account (OAuth, picker scope
// only), then each import opens Google's Photos Picker; whatever the user picks is
// downloaded into the BlobStore as photos in one named album (photos.memory). The
// screensaver's "albums" source then rotates across the albums the household chose.
import createAPI, { type Request, type Response } from 'lambda-api'
import { randomBytes } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { query } from '../../platform/db'
import { adminRoute } from '../../platform/route-guards'
import { decryptSecret, encryptSecret, encryptionAvailable } from '../../platform/crypto'
import { getBlobStore, mediaKey } from '../../platform/storage'
import { runJob } from '../../platform/jobs'
import {
  buildAuthUrl,
  createPickerSession,
  deletePickerSession,
  downloadPickedPhoto,
  exchangeCode,
  fetchUserinfo,
  getPickerSession,
  googlePhotosConfigured,
  listPickedMediaItems,
  photosGrant,
  PickerApiDisabledError,
  PickerSessionGoneError,
  refreshAccessToken,
} from '../../integrations/google'
import { resultPage } from '../calendar/calendars'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_TTL_MIN = 15
const ALBUM_MAX = 80
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

interface AccountRow extends QueryResultRow {
  id: string
  email: string | null
  refresh_token_encrypted: string
  access_token_encrypted: string | null
  access_token_expires_at: Date | null
  created_at: Date
}

interface ImportRow extends QueryResultRow {
  id: string
  person_id: string | null
  album: string
  session_id: string
  picker_uri: string
  expire_time: Date | null
  status: 'picking' | 'importing' | 'done' | 'failed' | 'expired'
  imported_count: number
  skipped_count: number
  error: string | null
  created_at: Date
}

function presentImport(r: ImportRow) {
  return {
    id: r.id,
    album: r.album,
    sessionId: r.session_id,
    pickerUri: r.picker_uri,
    expireTime: r.expire_time,
    status: r.status,
    importedCount: r.imported_count,
    skippedCount: r.skipped_count,
    error: r.error,
    createdAt: r.created_at,
  }
}

async function accountFor(householdId: string): Promise<AccountRow | null> {
  const { rows } = await query<AccountRow>(
    `select id, email, refresh_token_encrypted, access_token_encrypted, access_token_expires_at, created_at
       from google_photos_accounts where household_id = $1
      order by created_at desc limit 1`,
    [householdId]
  )
  return rows[0] ?? null
}

// A cached access token while it has a minute left; otherwise refresh and cache.
async function accessTokenFor(account: AccountRow): Promise<string> {
  const exp = account.access_token_expires_at?.getTime() ?? 0
  if (account.access_token_encrypted && exp > Date.now() + 60_000) {
    return decryptSecret(account.access_token_encrypted)
  }
  const tok = await refreshAccessToken(decryptSecret(account.refresh_token_encrypted))
  await query(
    `update google_photos_accounts
        set access_token_encrypted = $2, access_token_expires_at = now() + make_interval(secs => $3)
      where id = $1`,
    [account.id, encryptSecret(tok.accessToken), tok.expiresIn]
  )
  return tok.accessToken
}

async function getImport(householdId: string, id: string): Promise<ImportRow | null> {
  if (!UUID_RE.test(id)) return null
  const { rows } = await query<ImportRow>(
    `select * from google_photos_imports where household_id = $1 and id = $2`,
    [householdId, id]
  )
  return rows[0] ?? null
}

async function finishImport(id: string, status: ImportRow['status'], error: string | null = null): Promise<void> {
  await query(`update google_photos_imports set status = $2, error = $3 where id = $1`, [id, status, error])
}

// Download every picked photo into the album. Videos and unsupported formats are
// counted as skipped, as is a photo the household already has (re-pick).
export async function importPickedItems(householdId: string, importId: string): Promise<void> {
  const imp = await getImport(householdId, importId)
  const account = await accountFor(householdId)
  if (!imp || !account) return
  const uploadedBy = imp.person_id
  const store = getBlobStore()
  let imported = 0
  let skipped = 0
  try {
    const token = await accessTokenFor(account)
    let pageToken: string | null = null
    do {
      const page = await listPickedMediaItems(token, imp.session_id, pageToken)
      for (const item of page.items) {
        if (item.type !== 'PHOTO' || !item.baseUrl) {
          skipped++
          continue
        }
        const exists = await query(
          `select 1 from photos where household_id = $1 and source = 'google_photos' and external_id = $2`,
          [householdId, item.id]
        )
        if (exists.rows.length) {
          skipped++
          continue
        }
        const { bytes, contentType } = await downloadPickedPhoto(token, item.baseUrl)
        if (!ACCEPTED_TYPES.has(contentType)) {
          skipped++
          continue
        }
        const key = mediaKey(householdId, contentType)
        await store.put(key, bytes, contentType)
        const ins = await query(
          `insert into photos
             (household_id, storage_key, content_type, caption, memory, taken_at, uploaded_by, created_by, source, external_id)
           values ($1,$2,$3,'',$4,$5,$6,$6,'google_photos',$7)
           on conflict (household_id, source, external_id) where external_id is not null do nothing
           returning id`,
          [householdId, key, contentType, imp.album, item.createTime, uploadedBy, item.id]
        )
        if (ins.rows.length) imported++
        else {
          skipped++
          await store.delete(key)
        }
        await query(
          `update google_photos_imports set imported_count = $2, skipped_count = $3 where id = $1`,
          [importId, imported, skipped]
        )
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    await query(
      `update google_photos_imports set imported_count = $2, skipped_count = $3 where id = $1`,
      [importId, imported, skipped]
    )
    await deletePickerSession(token, imp.session_id).catch(() => undefined)
    await finishImport(importId, 'done')
  } catch (err) {
    console.error('google photos import failed', err)
    await finishImport(importId, 'failed', err instanceof Error ? err.message : 'import failed')
  }
}

// Advance a picking import: ask Google whether the user has finished, and hand
// the download off to a background job the first time they have. The guarded
// UPDATE makes sure two concurrent polls start only one job.
async function advanceImport(householdId: string, imp: ImportRow): Promise<void> {
  if (imp.status !== 'picking') return
  const account = await accountFor(householdId)
  if (!account) {
    await finishImport(imp.id, 'failed', 'Google Photos is no longer connected')
    return
  }
  let mediaItemsSet = false
  try {
    mediaItemsSet = (await getPickerSession(await accessTokenFor(account), imp.session_id)).mediaItemsSet
  } catch (err) {
    if (err instanceof PickerSessionGoneError) {
      await finishImport(imp.id, 'expired')
      return
    }
    throw err
  }
  if (!mediaItemsSet) return
  const { rows } = await query(
    `update google_photos_imports set status = 'importing' where id = $1 and status = 'picking' returning id`,
    [imp.id]
  )
  if (!rows.length) return
  void runJob(`google-photos-import:${imp.id}`, () => importPickedItems(householdId, imp.id)).catch((err) =>
    console.error('google photos import job failed', err)
  )
}

// Hard delete, so a later reconnect can import the same Google photos again
// (soft-deleted rows would still hold the external_id unique slot).
async function removeImportedPhotos(householdId: string): Promise<number> {
  const { rows } = await query<{ storage_key: string | null }>(
    `delete from photos where household_id = $1 and source = 'google_photos' returning storage_key`,
    [householdId]
  )
  await query(`delete from google_photos_imports where household_id = $1`, [householdId])
  const store = getBlobStore()
  await Promise.all(rows.map((r) => (r.storage_key ? store.delete(r.storage_key).catch(() => undefined) : undefined)))
  // Drop mix albums that no longer have any photo at all.
  await query(
    `update households h
        set settings = jsonb_set(h.settings, '{display,photoAlbums}', coalesce((
          select jsonb_agg(a) from jsonb_array_elements_text(h.settings->'display'->'photoAlbums') a
           where exists (select 1 from photos p where p.household_id = h.id and p.deleted_at is null and p.memory = a)
        ), '[]'::jsonb))
      where h.id = $1 and jsonb_typeof(h.settings->'display'->'photoAlbums') = 'array'`,
    [householdId]
  )
  return rows.length
}

interface AlbumSummaryRow extends QueryResultRow {
  name: string
  photo_count: number
  last_synced_at: Date
}

async function importedAlbums(householdId: string) {
  const { rows } = await query<AlbumSummaryRow>(
    `select ph.memory as name, count(*)::int as photo_count,
            greatest(max(ph.created_at), (
              select max(gi.updated_at) from google_photos_imports gi
               where gi.household_id = $1 and gi.album = ph.memory and gi.status = 'done'
            )) as last_synced_at
       from photos ph
      where ph.household_id = $1 and ph.source = 'google_photos' and ph.deleted_at is null and ph.memory is not null
      group by ph.memory
      order by ph.memory`,
    [householdId]
  )
  return rows.map((r) => ({ name: r.name, photoCount: r.photo_count, lastSyncedAt: r.last_synced_at }))
}

export function registerGooglePhotosRoutes(api: Api): void {
  api.post('/api/photos/google/connect', adminRoute(async (tenant, req: Request, res: Response) => {
    if (!googlePhotosConfigured()) {
      return res.status(501).json({
        error: 'NotConfigured',
        message: 'Google Photos is not configured on the server (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PHOTOS_REDIRECT_URI)',
      })
    }
    if (!encryptionAvailable()) {
      return res.status(501).json({
        error: 'NotConfigured',
        message: 'TOKEN_ENCRYPTION_KEY is not set; refresh tokens cannot be stored encrypted',
      })
    }
    const body = (req.body ?? {}) as { redirectTo?: unknown }
    const redirectTo = typeof body.redirectTo === 'string' ? body.redirectTo : null
    const state = randomBytes(24).toString('base64url')
    await query(
      `insert into google_photos_oauth_states (state, household_id, person_id, redirect_to) values ($1,$2,$3,$4)`,
      [state, tenant.householdId, tenant.personId, redirectTo]
    )
    return { url: buildAuthUrl(state, photosGrant()) }
  }))

  // PUBLIC — Google redirects the browser here; the one-time state resolves the household.
  api.get('/auth/google/photos/callback', async (req: Request, res: Response) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>
    if (q.error) return res.status(400).html(resultPage('Connection cancelled', `Google returned: ${q.error}`))
    const code = typeof q.code === 'string' ? q.code : ''
    const state = typeof q.state === 'string' ? q.state : ''
    if (!code || !state) {
      return res.status(400).html(resultPage('Connection failed', 'Missing authorization code or state.'))
    }
    const { rows } = await query<{ household_id: string; person_id: string | null; redirect_to: string | null }>(
      `delete from google_photos_oauth_states
        where state = $1 and created_at > now() - interval '${STATE_TTL_MIN} minutes'
        returning household_id, person_id, redirect_to`,
      [state]
    )
    await query(`delete from google_photos_oauth_states where created_at <= now() - interval '${STATE_TTL_MIN} minutes'`)
    const st = rows[0]
    if (!st) {
      return res.status(400).html(resultPage('Link expired', 'This connection link has expired. Please try connecting again.'))
    }
    try {
      const tokens = await exchangeCode(code, photosGrant())
      if (!tokens.refreshToken) throw new Error('Google did not return a refresh token')
      const info = await fetchUserinfo(tokens.accessToken)
      await query(
        `insert into google_photos_accounts
           (household_id, person_id, google_sub, email, scope, refresh_token_encrypted,
            access_token_encrypted, access_token_expires_at)
         values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))
         on conflict (household_id, google_sub) do update set
           email = excluded.email,
           scope = excluded.scope,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           access_token_encrypted = excluded.access_token_encrypted,
           access_token_expires_at = excluded.access_token_expires_at`,
        [
          st.household_id,
          st.person_id,
          info.sub,
          info.email,
          tokens.scope,
          encryptSecret(tokens.refreshToken),
          encryptSecret(tokens.accessToken),
          tokens.expiresIn,
        ]
      )
    } catch (err) {
      console.error('google photos callback failed', err)
      return res.status(502).html(resultPage('Connection failed', 'Could not complete the Google Photos connection. Please try again.'))
    }
    if (st.redirect_to) return res.redirect(st.redirect_to)
    return res.html(resultPage('Google Photos connected', 'You can close this tab and return to Waffled.'))
  })

  api.get('/api/photos/google/status', adminRoute(async (tenant) => {
    const account = await accountFor(tenant.householdId)
    const { rows } = await query<ImportRow>(
      `select * from google_photos_imports where household_id = $1 order by created_at desc limit 20`,
      [tenant.householdId]
    )
    const albums = await importedAlbums(tenant.householdId)
    return {
      configured: googlePhotosConfigured() && encryptionAvailable(),
      account: account ? { id: account.id, email: account.email, connectedAt: account.created_at } : null,
      imports: rows.map(presentImport),
      albums,
      photoCount: albums.reduce((n, a) => n + a.photoCount, 0),
    }
  }))

  // Disconnecting takes everything Google brought in with it: the imported photos
  // (rows + files), the import history, and those albums from the screensaver mix.
  api.delete('/api/photos/google/accounts/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound' })
    const { rows } = await query(
      `delete from google_photos_accounts where household_id = $1 and id = $2 returning id`,
      [tenant.householdId, id]
    )
    if (!rows.length) return res.status(404).json({ error: 'NotFound' })
    const removed = await removeImportedPhotos(tenant.householdId)
    return { ok: true, removedPhotos: removed }
  }))

  api.post('/api/photos/google/imports', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { album?: unknown }
    const album = typeof body.album === 'string' ? body.album.trim().slice(0, ALBUM_MAX) : ''
    if (!album) return res.status(400).json({ error: 'BadRequest', message: 'album is required' })
    const account = await accountFor(tenant.householdId)
    if (!account) return res.status(409).json({ error: 'NotConnected', message: 'Connect Google Photos first' })
    let session
    try {
      session = await createPickerSession(await accessTokenFor(account))
    } catch (err) {
      if (err instanceof PickerApiDisabledError) {
        return res.status(502).json({
          error: 'PickerApiDisabled',
          message: 'The Google Photos Picker API is turned off in your Google Cloud project. Enable it, wait a few minutes, then try again.',
          enableUrl: err.enableUrl,
        })
      }
      console.error('google photos session failed', err)
      return res.status(502).json({ error: 'UpstreamError', message: 'Google Photos did not start a picker session. Try reconnecting.' })
    }
    const { rows } = await query<ImportRow>(
      `insert into google_photos_imports (household_id, account_id, person_id, album, session_id, picker_uri, expire_time)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [tenant.householdId, account.id, tenant.personId, album, session.id, session.pickerUri, session.expireTime]
    )
    return res.status(201).json({ import: presentImport(rows[0]) })
  }))

  api.get('/api/photos/google/imports/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const imp = await getImport(tenant.householdId, String(req.params.id))
    if (!imp) return res.status(404).json({ error: 'NotFound' })
    try {
      await advanceImport(tenant.householdId, imp)
    } catch (err) {
      console.error('google photos poll failed', err)
    }
    const fresh = await getImport(tenant.householdId, imp.id)
    return { import: presentImport(fresh ?? imp) }
  }))
}
