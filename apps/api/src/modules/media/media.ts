// Blob upload endpoint (POST /api/media). The container server buffers the request
// body to a STRING (isBase64Encoded:false), so raw binary multipart is unsafe —
// uploads arrive as base64 inside a JSON body. We decode, size-check, hand the bytes
// to the blob store, and return the opaque key + its resolved URL. Callers (photos /
// recipes) then persist that key as their image's storage_key.
import createAPI, { type Request, type Response } from 'lambda-api'
import { tenantRoute } from '../../platform/route-guards'
import { getBlobStore, mediaKey, mediaUrl } from '../../platform/storage'

type Api = ReturnType<typeof createAPI>

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB decoded

export function registerMediaRoutes(api: Api): void {
  api.post('/api/media', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { data?: unknown; contentType?: unknown }

    const contentType = typeof body.contentType === 'string' ? body.contentType : ''
    if (!ALLOWED.has(contentType)) {
      return res
        .status(400)
        .json({ error: 'BadRequest', message: 'contentType must be one of image/jpeg, image/png, image/webp' })
    }
    if (typeof body.data !== 'string' || !body.data) {
      return res.status(400).json({ error: 'BadRequest', message: 'data (base64) is required' })
    }

    const buf = Buffer.from(body.data, 'base64')
    if (buf.byteLength === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'data is not valid base64' })
    }
    if (buf.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: 'PayloadTooLarge', message: 'image exceeds the 10 MB limit' })
    }

    const key = mediaKey(tenant.householdId, contentType)
    await getBlobStore().put(key, buf, contentType)
    return res.status(201).json({ key, url: mediaUrl(key), contentType })
  }))
}
