import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpServer } from '../src/platform/http-server'

const INDEX = '<!doctype html><title>spa</title>'
const SECRET = 'TOP-SECRET'

let base: string
let server: http.Server
let tmp: string

const fakeApi = {
  run: async () => ({ statusCode: 404, body: '{"error":"NotFound"}' }),
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'waffled-static-'))
  const webRoot = join(tmp, 'web')
  const mediaRoot = join(tmp, 'media')
  mkdirSync(join(webRoot, 'assets'), { recursive: true })
  mkdirSync(join(mediaRoot, 'h1'), { recursive: true })
  writeFileSync(join(webRoot, 'index.html'), INDEX)
  writeFileSync(join(webRoot, 'assets', 'app.abc.js'), 'console.log(1)')
  writeFileSync(join(webRoot, 'sw.js'), 'self.skip()')
  writeFileSync(join(mediaRoot, 'h1', 'a.jpg'), 'jpegbytes')
  writeFileSync(join(tmp, 'secrets.json'), SECRET)
  server = createHttpServer(fakeApi, { webRoot, mediaRoot })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

const get = (path: string, method = 'GET') => fetch(base + path, { method })

describe('static serving', () => {
  it('serves index.html at / with no-cache', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('falls back to index.html for SPA routes', async () => {
    const res = await get('/meals/recipe/123/cook')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
  })

  it('serves hashed assets as immutable', async () => {
    const res = await get('/assets/app.abc.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('serves sw.js with no-cache', async () => {
    const res = await get('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('serves media immutable and 404s missing media', async () => {
    const ok = await get('/media/h1/a.jpg')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/jpeg')
    expect(ok.headers.get('cache-control')).toContain('immutable')
    expect((await get('/media/h1/missing.jpg')).status).toBe(404)
  })

  it.each(['/media/../secrets.json', '/media/%2e%2e/secrets.json', '/%2e%2e/secrets.json', '/media/..%2fsecrets.json'])(
    'never leaks files outside the roots (%s)',
    async (p) => {
      const res = await get(p)
      expect([200, 404]).toContain(res.status)
      expect(await res.text()).not.toContain(SECRET)
    },
  )

  it('routes /api and /auth to the api, not index.html', async () => {
    for (const p of ['/api/nope', '/auth/microsoft/calendar/callback']) {
      const res = await get(p)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'NotFound' })
    }
  })

  it('HEAD / returns an empty body', async () => {
    const res = await get('/', 'HEAD')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
