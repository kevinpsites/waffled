// Blob upload endpoint (POST /api/media). The container server buffers the request
// body to a STRING (isBase64Encoded:false), so raw binary multipart is unsafe —
// uploads arrive as base64 inside a JSON body. We decode, size-check, hand the bytes
// to the blob store, and return the opaque key + its resolved URL. Callers (photos /
// recipes) then persist that key as their image's storage_key.
import createAPI, { type Request, type Response } from 'lambda-api'
import { tenantRoute } from '../../platform/route-guards'
import { getBlobStore, mediaKey, mediaUrl, verifyMediaUrl } from '../../platform/storage'

type Api = ReturnType<typeof createAPI>

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB decoded

function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const dataEnd = value.length - padding
  for (let i = 0; i < dataEnd; i += 1) {
    const code = value.charCodeAt(i)
    const allowed = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f
    if (!allowed) return false
  }
  for (let i = dataEnd; i < value.length; i += 1) {
    if (value.charCodeAt(i) !== 0x3d) return false
  }
  return true
}

// Do not trust the client-supplied MIME label: these signatures cover the image
// formats accepted by the product and prevent HTML/script payloads from being served
// from the application's own origin under a misleading content type.
function bytesMatchContentType(bytes: Buffer, contentType: string): boolean {
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (contentType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (contentType === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

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
    if (!isStrictBase64(body.data)) {
      return res.status(400).json({ error: 'BadRequest', message: 'data is not valid base64' })
    }

    const buf = Buffer.from(body.data, 'base64')
    if (buf.byteLength === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'data is not valid base64' })
    }
    if (buf.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: 'PayloadTooLarge', message: 'image exceeds the 10 MB limit' })
    }
    if (!bytesMatchContentType(buf, contentType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'image bytes do not match contentType' })
    }

    const key = mediaKey(tenant.householdId, contentType)
    await getBlobStore().put(key, buf, contentType)
    return res.status(201).json({ key, url: mediaUrl(key), contentType })
  }))

  // Caddy's forward_auth subrequest lands here before any /media/* file read. The
  // original URI is supplied by Caddy, not accepted from a URL query parameter.
  api.get('/api/media/authorize', (req: Request, res: Response) => {
    const forwardedUri = req.headers['x-forwarded-uri']
    if (typeof forwardedUri !== 'string') return res.status(403).send('')

    let url: URL
    try {
      url = new URL(forwardedUri, 'http://waffled-media.local')
    } catch {
      return res.status(403).send('')
    }
    if (!url.pathname.startsWith('/media/')) return res.status(403).send('')

    let key: string
    try {
      key = decodeURIComponent(url.pathname.slice('/media/'.length))
    } catch {
      return res.status(403).send('')
    }
    if (!verifyMediaUrl(key, url.searchParams.get('expires'), url.searchParams.get('sig'))) {
      return res.status(403).send('')
    }
    return res.status(200).send('')
  })
}
