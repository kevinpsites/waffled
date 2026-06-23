import { uploadImage, MAX_UPLOAD_BYTES } from './media'

// A File whose `type` and `size` we control. jsdom's File reports byte length from the
// blob parts, so we override `size` directly to simulate a large file without allocating.
function fakeFile(type: string, size: number): File {
  const f = new File(['x'], 'photo', { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

// Stub the canvas/Image pipeline so the happy path runs in jsdom (no real raster). Image
// resolves immediately with a small size (no downscale); canvas.toDataURL returns a fixed
// data URL we can assert the base64 stripping against.
function stubCanvas(dataUrl: string) {
  // @ts-expect-error — minimal Image stub
  globalThis.Image = class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    width = 100
    height = 80
    private _src = ''
    set src(v: string) {
      this._src = v
      queueMicrotask(() => this.onload?.())
    }
    get src() {
      return this._src
    }
  }
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake')
  globalThis.URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('uploadImage — guards', () => {
  it('rejects an unsupported (HEIC) type before any work', async () => {
    await expect(uploadImage(fakeFile('image/heic', 1000))).rejects.toThrow(/JPEG, PNG, or WebP/i)
  })

  it('rejects a file over the 10 MB limit', async () => {
    await expect(uploadImage(fakeFile('image/jpeg', MAX_UPLOAD_BYTES + 1))).rejects.toThrow(/10 MB/i)
  })
})

describe('uploadImage — happy path', () => {
  it('re-encodes, strips the base64 prefix, and POSTs { data, contentType } to /api/media', async () => {
    stubCanvas('data:image/jpeg;base64,QUJD')
    const sent: { url: string; method: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      sent.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: true, json: async () => ({ key: 'media/abc.jpg', url: '/media/abc.jpg', contentType: 'image/jpeg' }) }
    }) as unknown as typeof fetch

    const res = await uploadImage(fakeFile('image/jpeg', 5000))

    expect(res).toEqual({ key: 'media/abc.jpg', url: '/media/abc.jpg', contentType: 'image/jpeg' })
    const post = sent.find((s) => s.url.endsWith('/api/media') && s.method === 'POST')!
    expect(post).toBeTruthy()
    expect(post.body).toEqual({ data: 'QUJD', contentType: 'image/jpeg' })
  })

  it('keeps WebP as WebP', async () => {
    stubCanvas('data:image/webp;base64,V0VC')
    const sent: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: true, json: async () => ({ key: 'k', url: 'u', contentType: 'image/webp' }) }
    }) as unknown as typeof fetch

    await uploadImage(fakeFile('image/webp', 5000))
    const post = sent.find((s) => s.url.endsWith('/api/media'))!
    expect((post.body as { contentType: string }).contentType).toBe('image/webp')
  })
})
