// Photos / memories domain — matches the handoff Photos mocks (the family wall →
// screensaver, the "NEW MEMORY · Lake Day" banner, add-photos, and the photo
// detail). Household-scoped + soft-deleted, mirroring goals.ts.
//
// No blob-storage / file-upload infra exists yet, so a photo is EITHER an image
// URL (image_url) OR an emoji + color tile (emoji + color_hex). The mock itself
// renders colored emoji tiles, so the tile is the intended fallback — the wall,
// screensaver and detail all draw an emoji-on-gradient tile when image_url is null.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from '../../platform/db'
import { type Tenant } from '../households/households'
import { tenantRoute } from '../../platform/route-guards'
import { getBlobStore, mediaKeyBelongsToHousehold, mediaUrl } from '../../platform/storage'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PhotoRow extends QueryResultRow {
  id: string
  image_url: string | null
  storage_key: string | null
  content_type: string | null
  caption: string
  emoji: string | null
  color_hex: string | null
  memory: string | null
  taken_at: string | null
  is_favorite: boolean
  reactions: Record<string, number>
  uploaded_by: string | null
  uploaded_by_name: string | null
  uploaded_by_emoji: string | null
  uploaded_by_color: string | null
  created_at: string
}

function mapPhoto(r: PhotoRow) {
  return {
    id: r.id,
    // A stored blob (storage_key) wins; otherwise fall back to the external link.
    imageUrl: mediaUrl(r.storage_key) ?? r.image_url,
    caption: r.caption,
    emoji: r.emoji,
    colorHex: r.color_hex,
    memory: r.memory,
    takenAt: r.taken_at,
    isFavorite: r.is_favorite,
    reactions: r.reactions ?? {},
    uploadedBy: r.uploaded_by
      ? {
          personId: r.uploaded_by,
          name: r.uploaded_by_name,
          avatarEmoji: r.uploaded_by_emoji,
          colorHex: r.uploaded_by_color,
        }
      : null,
    createdAt: r.created_at,
  }
}

const SELECT_PHOTO = `
  select ph.id, ph.image_url, ph.storage_key, ph.content_type, ph.caption, ph.emoji, ph.color_hex, ph.memory,
         ph.taken_at, ph.is_favorite, ph.reactions, ph.uploaded_by, ph.created_at,
         p.name as uploaded_by_name, p.avatar_emoji as uploaded_by_emoji, p.color_hex as uploaded_by_color
    from photos ph
    left join persons p on p.id = ph.uploaded_by and p.deleted_at is null`

// Newest first (taken_at, then created_at). Optional memory filter.
export async function listPhotos(householdId: string, memory?: string | null) {
  const { rows } = await query<PhotoRow>(
    `${SELECT_PHOTO}
      where ph.household_id = $1 and ph.deleted_at is null
        and ($2::text is null or ph.memory = $2)
      order by coalesce(ph.taken_at, ph.created_at) desc, ph.created_at desc`,
    [householdId, memory ?? null]
  )
  return rows.map(mapPhoto)
}

export async function getPhoto(householdId: string, id: string) {
  const { rows } = await query<PhotoRow>(
    `${SELECT_PHOTO} where ph.household_id = $1 and ph.id = $2 and ph.deleted_at is null`,
    [householdId, id]
  )
  return rows.length ? mapPhoto(rows[0]) : null
}

export interface CreatePhotoInput {
  caption?: string
  imageUrl?: string | null
  storageKey?: string | null
  contentType?: string | null
  emoji?: string | null
  colorHex?: string | null
  memory?: string | null
  takenAt?: string | null
  isFavorite?: boolean
  reactions?: Record<string, number> | null
  uploadedBy?: string | null
}

export async function createPhoto(tenant: Tenant, input: CreatePhotoInput): Promise<{ id: string }> {
  const { rows } = await query<{ id: string }>(
    `insert into photos
       (household_id, image_url, storage_key, content_type, caption, emoji, color_hex, memory, taken_at, is_favorite, reactions, uploaded_by, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      tenant.householdId,
      input.imageUrl ?? null,
      input.storageKey ?? null,
      input.contentType ?? null,
      (input.caption ?? '').trim(),
      input.emoji ?? null,
      input.colorHex ?? null,
      input.memory ?? null,
      input.takenAt ?? null,
      input.isFavorite ?? false,
      JSON.stringify(input.reactions ?? {}),
      input.uploadedBy ?? tenant.personId,
      tenant.personId,
    ]
  )
  return { id: rows[0].id }
}

export interface UpdatePhotoInput {
  caption?: string
  memory?: string | null
  isFavorite?: boolean
  takenAt?: string | null
}

// Partial update — builds the UPDATE from only the provided fields (mirrors
// meals.service updateRecipe). Scoped to the household + live rows. Returns the
// updated, mapped photo, or null if no row matched or nothing was provided.
export async function updatePhoto(
  householdId: string,
  id: string,
  patch: UpdatePhotoInput
): Promise<ReturnType<typeof mapPhoto> | null> {
  const cols: string[] = []
  const vals: unknown[] = []
  const set = (col: string, val: unknown) => { cols.push(`${col} = $${cols.length + 1}`); vals.push(val) }

  // caption is optional: a string (even blank) sets it; blank clears the label.
  if (typeof patch.caption === 'string') set('caption', patch.caption.trim())
  // empty / whitespace memory un-albums the photo (NULL).
  if (patch.memory !== undefined) set('memory', (patch.memory ?? '').trim() || null)
  if (typeof patch.isFavorite === 'boolean') set('is_favorite', patch.isFavorite)
  if (patch.takenAt !== undefined) set('taken_at', patch.takenAt ?? null)

  if (cols.length === 0) return null

  const { rows } = await query<{ id: string }>(
    `update photos set ${cols.join(', ')}
       where household_id = $${cols.length + 1} and id = $${cols.length + 2} and deleted_at is null
       returning id`,
    [...vals, householdId, id]
  )
  if (!rows.length) return null
  return getPhoto(householdId, id)
}

// Soft-deletes and returns the photo's storage_key (if any) so the caller can
// best-effort drop the backing blob. Returns false when no live photo matched.
export async function softDeletePhoto(
  householdId: string,
  id: string
): Promise<{ storageKey: string | null } | false> {
  const { rows } = await query<{ storage_key: string | null }>(
    `update photos set deleted_at = now()
       where household_id=$1 and id=$2 and deleted_at is null
       returning storage_key`,
    [householdId, id]
  )
  return rows.length ? { storageKey: rows[0].storage_key } : false
}

// ---- routes -----------------------------------------------------------------

export function registerPhotoRoutes(api: Api): void {
  api.get('/api/photos', tenantRoute(async (tenant, req: Request) => {
    const memory = (req.query?.memory as string | undefined) || null
    return { photos: await listPhotos(tenant.householdId, memory) }
  }))

  api.get('/api/photos/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'photo not found' })
    const photo = await getPhoto(tenant.householdId, id)
    if (!photo) return res.status(404).json({ error: 'NotFound', message: 'photo not found' })
    return { photo }
  }))

  api.post('/api/photos', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<CreatePhotoInput>
    if (body.storageKey != null && (
      typeof body.storageKey !== 'string' ||
      !mediaKeyBelongsToHousehold(body.storageKey, tenant.householdId)
    )) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid uploaded image key' })
    }
    // caption is optional (blank by default); a tile still needs an image or emoji.
    if (!body.imageUrl && !body.storageKey && !body.emoji) {
      return res.status(400).json({ error: 'BadRequest', message: 'an image url, an uploaded image, or an emoji is required' })
    }
    const photo = await createPhoto(tenant, body as CreatePhotoInput)
    return res.status(201).json({ photo })
  }))

  api.patch('/api/photos/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'photo not found' })
    const body = (req.body ?? {}) as Partial<UpdatePhotoInput>
    const patch: UpdatePhotoInput = {}
    if (body.caption !== undefined) patch.caption = body.caption
    if (body.memory !== undefined) patch.memory = body.memory
    if (typeof body.isFavorite === 'boolean') patch.isFavorite = body.isFavorite
    if (body.takenAt !== undefined) patch.takenAt = body.takenAt
    const photo = await updatePhoto(tenant.householdId, id, patch)
    if (!photo) return res.status(404).json({ error: 'NotFound', message: 'photo not found' })
    return { photo }
  }))

  api.delete('/api/photos/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'photo not found' })
    const deleted = await softDeletePhoto(tenant.householdId, id)
    if (!deleted) return res.status(404).json({ error: 'NotFound', message: 'photo not found' })
    // Best-effort: drop the backing blob. A storage failure must not fail the delete.
    if (deleted.storageKey) {
      try {
        await getBlobStore().delete(deleted.storageKey)
      } catch {
        // ignore — the row is gone; an orphaned blob is harmless.
      }
    }
    return res.status(204).send('')
  }))
}
