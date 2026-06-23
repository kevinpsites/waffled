// Media (image blob) upload — client slice. The kiosk lets the family attach real
// photos to memories and recipes. We never ship the raw file: we re-encode it via an
// offscreen <canvas> (downscaling the long edge to ~2048px and normalizing EXIF
// orientation), base64 it, and POST JSON to /api/media. The server stores the blob and
// returns a stable { key, url }. Callers then save the owning entity with `storageKey: key`.
import { apiSend } from './client'

// Content types both the browser canvas and the server accept. HEIC is intentionally
// excluded — Chrome can't decode it, so we reject it early with a friendly message.
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'] as const
type AllowedType = (typeof ALLOWED)[number]

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // server rejects >10MB decoded
const MAX_EDGE = 2048 // long-edge cap for the re-encoded image

export interface UploadedImage {
  key: string
  url: string
  contentType: string
}

const isAllowed = (t: string): t is AllowedType => (ALLOWED as readonly string[]).includes(t)

// Friendly, user-facing guard errors (surfaced inline in the upload UIs).
const BAD_TYPE_MSG = 'Please choose a JPEG, PNG, or WebP image (HEIC photos from iPhone aren’t supported here).'
const TOO_BIG_MSG = 'That image is too large — please choose one under 10 MB.'

// Re-encode a file through a canvas: load → (optionally) downscale the long edge to
// MAX_EDGE → draw → toDataURL. Drawing through the canvas also bakes in the right EXIF
// orientation. WebP input stays WebP; everything else becomes JPEG. Returns the data URL.
async function reencode(file: File, contentType: AllowedType): Promise<string> {
  const img = await loadImage(file)
  const { width, height } = img
  const longEdge = Math.max(width, height)
  const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process that image — please try a different one.')
  ctx.drawImage(img, 0, 0, w, h)
  if (typeof URL !== 'undefined' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)

  const outType: AllowedType = contentType === 'image/webp' ? 'image/webp' : 'image/jpeg'
  return canvas.toDataURL(outType, 0.85)
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => resolve(img)
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image — please try a different one.'))
    }
    img.src = url
  })
}

// Strip the "data:<type>;base64," prefix → bare base64 the server expects.
function stripDataUrl(dataUrl: string): { data: string; contentType: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) throw new Error('Could not process that image — please try a different one.')
  return { contentType: m[1], data: m[2] }
}

// Upload a chosen file: validate type + size up front (fail fast), downscale/re-encode
// via canvas, then POST { data, contentType } to /api/media. Resolves to { key, url, contentType }.
export async function uploadImage(file: File): Promise<UploadedImage> {
  if (!isAllowed(file.type)) throw new Error(BAD_TYPE_MSG)
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(TOO_BIG_MSG)

  const dataUrl = await reencode(file, file.type)
  const { data, contentType } = stripDataUrl(dataUrl)
  return apiSend<UploadedImage>('POST', '/api/media', { data, contentType })
}
