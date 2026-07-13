// Storage layer — plain vitest, no Testcontainers. Points MEDIA_DIR at a temp dir
// and exercises the local driver round-trip, the key/url helpers, and the s3 stub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { getBlobStore, mediaKey, mediaKeyBelongsToHousehold, mediaUrl } from '../src/platform/storage'

const HOUSEHOLD = '11111111-1111-1111-1111-111111111111'

let dir: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.MEDIA_DIR = process.env.MEDIA_DIR
  savedEnv.MEDIA_BASE_URL = process.env.MEDIA_BASE_URL
  savedEnv.STORAGE_DRIVER = process.env.STORAGE_DRIVER
  dir = join(tmpdir(), `waffled-storage-${randomBytes(8).toString('hex')}`)
  process.env.MEDIA_DIR = dir
  delete process.env.MEDIA_BASE_URL
  delete process.env.STORAGE_DRIVER
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  for (const k of ['MEDIA_DIR', 'MEDIA_BASE_URL', 'STORAGE_DRIVER'] as const) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('local blob store', () => {
  it('put writes the bytes (creating the household subdir) and they read back', async () => {
    const store = getBlobStore()
    const key = mediaKey(HOUSEHOLD, 'image/png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await store.put(key, bytes, 'image/png')
    const onDisk = await readFile(join(dir, key))
    expect(Buffer.compare(onDisk, bytes)).toBe(0)
  })

  it('delete removes the file and is idempotent on a missing key', async () => {
    const store = getBlobStore()
    const key = mediaKey(HOUSEHOLD, 'image/jpeg')
    await store.put(key, Buffer.from('hello'), 'image/jpeg')
    await store.delete(key)
    await expect(stat(join(dir, key))).rejects.toMatchObject({ code: 'ENOENT' })
    // deleting again does not throw
    await expect(store.delete(key)).resolves.toBeUndefined()
  })

  it('rejects paths that could escape the media directory', async () => {
    const store = getBlobStore()
    await expect(store.put('../outside.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow('invalid media key')
    await expect(store.delete(`${HOUSEHOLD}/../../outside.jpg`)).rejects.toThrow('invalid media key')
  })
})

describe('mediaKey', () => {
  it('namespaces by household, is unique, and maps content types to extensions', () => {
    const a = mediaKey(HOUSEHOLD, 'image/jpeg')
    const b = mediaKey(HOUSEHOLD, 'image/jpeg')
    expect(a).not.toBe(b)
    expect(a.startsWith(`${HOUSEHOLD}/`)).toBe(true)
    expect(a.endsWith('.jpg')).toBe(true)
    expect(mediaKey(HOUSEHOLD, 'image/png').endsWith('.png')).toBe(true)
    expect(mediaKey(HOUSEHOLD, 'image/webp').endsWith('.webp')).toBe(true)
    // 16 random bytes → 32 hex chars
    expect(a).toMatch(new RegExp(`^${HOUSEHOLD}/[0-9a-f]{32}\\.jpg$`))
  })

  it('validates the active household namespace and a single safe filename', () => {
    const filename = 'a'.repeat(32)
    expect(mediaKeyBelongsToHousehold(`${HOUSEHOLD}/${filename}.jpg`, HOUSEHOLD)).toBe(true)
    expect(mediaKeyBelongsToHousehold(`22222222-2222-2222-2222-222222222222/${filename}.jpg`, HOUSEHOLD)).toBe(false)
    expect(mediaKeyBelongsToHousehold(`${HOUSEHOLD}/../${filename}.jpg`, HOUSEHOLD)).toBe(false)
    expect(mediaKeyBelongsToHousehold(`${HOUSEHOLD}/%2e%2e%2f${filename}.jpg`, HOUSEHOLD)).toBe(false)
    expect(mediaKeyBelongsToHousehold(`${HOUSEHOLD}/nested/${filename}.jpg`, HOUSEHOLD)).toBe(false)
    expect(mediaKeyBelongsToHousehold(`${HOUSEHOLD}/${filename}.gif`, HOUSEHOLD)).toBe(false)
    expect(mediaKeyBelongsToHousehold(`${HOUSEHOLD}/${filename.toUpperCase()}.jpg`, HOUSEHOLD)).toBe(false)
  })
})

describe('mediaUrl', () => {
  it('returns null for no key', () => {
    expect(mediaUrl(null)).toBeNull()
    expect(mediaUrl(undefined)).toBeNull()
    expect(mediaUrl('')).toBeNull()
  })

  it('builds from the default base', () => {
    const key = `${HOUSEHOLD}/${'a'.repeat(32)}.jpg`
    expect(mediaUrl(key)).toBe(`/media/${key}`)
  })

  it('honors a custom MEDIA_BASE_URL', () => {
    process.env.MEDIA_BASE_URL = 'https://cdn.example.com/m'
    const key = `${HOUSEHOLD}/${'a'.repeat(32)}.jpg`
    expect(mediaUrl(key)).toBe(`https://cdn.example.com/m/${key}`)
  })

  it('does not expose malformed stored keys', () => {
    expect(mediaUrl('../secret')).toBeNull()
    expect(mediaUrl(`${HOUSEHOLD}/../../secret`)).toBeNull()
  })
})

describe('s3 driver', () => {
  it('throws on use (a not-yet-configured seam)', async () => {
    process.env.STORAGE_DRIVER = 's3'
    const store = getBlobStore()
    await expect(store.put('k', Buffer.from('x'), 'image/png')).rejects.toThrow(
      's3 storage driver not configured yet'
    )
    await expect(store.delete('k')).rejects.toThrow('s3 storage driver not configured yet')
  })
})
