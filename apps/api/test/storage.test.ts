// Storage layer — plain vitest, no Testcontainers. Points MEDIA_DIR at a temp dir
// and exercises the local driver round-trip, the key/url helpers, and the s3 stub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { getBlobStore, mediaKey, mediaUrl } from '../src/platform/storage'

const HOUSEHOLD = '11111111-1111-1111-1111-111111111111'

let dir: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv.MEDIA_DIR = process.env.MEDIA_DIR
  savedEnv.MEDIA_BASE_URL = process.env.MEDIA_BASE_URL
  savedEnv.STORAGE_DRIVER = process.env.STORAGE_DRIVER
  dir = join(tmpdir(), `nook-storage-${randomBytes(8).toString('hex')}`)
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
})

describe('mediaUrl', () => {
  it('returns null for no key', () => {
    expect(mediaUrl(null)).toBeNull()
    expect(mediaUrl(undefined)).toBeNull()
    expect(mediaUrl('')).toBeNull()
  })

  it('builds from the default base', () => {
    expect(mediaUrl(`${HOUSEHOLD}/abc.jpg`)).toBe(`/media/${HOUSEHOLD}/abc.jpg`)
  })

  it('honors a custom MEDIA_BASE_URL', () => {
    process.env.MEDIA_BASE_URL = 'https://cdn.example.com/m'
    expect(mediaUrl(`${HOUSEHOLD}/abc.jpg`)).toBe(`https://cdn.example.com/m/${HOUSEHOLD}/abc.jpg`)
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
