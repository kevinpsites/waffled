// Blob storage layer. One place that knows how to persist an uploaded image and
// hand back a stable key. The *driver* is pluggable (STORAGE_DRIVER): `local`
// writes under MEDIA_DIR on the container's writable fs (container-only — Lambda
// can't write there), and `s3` is a stub seam for later. Mirrors the LLM provider
// factory style in platform/llm.ts: a small interface + a driver-keyed factory.
//
// Keys are `<householdId>/<hex>.<ext>` so blobs are namespaced per household and the
// random hex avoids collisions. The public URL is resolved at READ time from the
// key via mediaUrl(), so MEDIA_BASE_URL can change without a migration.
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export interface BlobStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  delete(key: string): Promise<void>
}

// contentType → file extension. Only the three image types we accept on upload.
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function extFor(contentType: string): string {
  return EXT_BY_TYPE[contentType] ?? 'bin'
}

function mediaDir(): string {
  return process.env.MEDIA_DIR || '/data/media'
}

const MEDIA_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{32})\.(jpg|png|webp)$/

export function mediaKeyBelongsToHousehold(key: string, householdId: string): boolean {
  const match = MEDIA_KEY_RE.exec(key)
  return match !== null && match[1] === householdId
}

function localMediaPath(key: string): string {
  if (!MEDIA_KEY_RE.test(key)) throw new Error('invalid media key')
  const root = resolve(mediaDir())
  const path = resolve(root, key)
  if (!path.startsWith(`${root}${sep}`)) throw new Error('invalid media key')
  return path
}

// Local-disk driver. Writes to MEDIA_DIR/<key>, creating the household subdir as
// needed. Container-only — relies on a writable filesystem.
class LocalBlobStore implements BlobStore {
  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const path = localMediaPath(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async delete(key: string): Promise<void> {
    const path = localMediaPath(key)
    try {
      await unlink(path)
    } catch (err) {
      // Missing file is fine — delete is best-effort / idempotent.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

// S3 driver — not wired up yet. A seam so the storage call sites don't change when
// object storage lands.
class S3BlobStore implements BlobStore {
  async put(): Promise<void> {
    throw new Error('s3 storage driver not configured yet')
  }
  async delete(): Promise<void> {
    throw new Error('s3 storage driver not configured yet')
  }
}

// Factory keyed on STORAGE_DRIVER (default 'local'). Constructed per call so a test
// can flip the env between cases.
export function getBlobStore(): BlobStore {
  const driver = process.env.STORAGE_DRIVER || 'local'
  if (driver === 's3') return new S3BlobStore()
  return new LocalBlobStore()
}

// A fresh, namespaced key for a new blob: `<householdId>/<hex>.<ext>`.
export function mediaKey(householdId: string, contentType: string): string {
  const hex = randomBytes(16).toString('hex')
  return `${householdId}/${hex}.${extFor(contentType)}`
}

// Resolve a stored key to its public URL (or null when there's no key). The base is
// MEDIA_BASE_URL (default '/media'), so it can change without rewriting stored keys.
export function mediaUrl(key: string | null | undefined): string | null {
  if (!key || !MEDIA_KEY_RE.test(key)) return null
  const base = process.env.MEDIA_BASE_URL || '/media'
  return `${base}/${key}`
}
