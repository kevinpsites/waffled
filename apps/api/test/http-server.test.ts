import { describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { type AddressInfo } from 'node:net'
import {
  createHttpServer,
  DEFAULT_BODY_LIMIT_BYTES,
  MEDIA_BODY_LIMIT_BYTES,
} from '../src/platform/http-server'

async function post(
  path: string,
  body: Buffer,
  includeLength = true
): Promise<{ status: number; body: string; routeCalls: number }> {
  const app = {
    run: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ ok: true }) })),
  }
  const server = createHttpServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(includeLength ? { 'content-length': body.byteLength } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const result = {
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          routeCalls: app.run.mock.calls.length,
        }
        server.close((error) => error ? reject(error) : resolve(result))
      })
    })
    req.on('error', (error) => server.close(() => reject(error)))
    req.end(body)
  })
}

describe('Node HTTP request body limits', () => {
  it('rejects an oversized ordinary JSON body before route handling', async () => {
    const result = await post('/api/auth/login', Buffer.alloc(DEFAULT_BODY_LIMIT_BYTES + 1, 'a'))
    expect(result.status).toBe(413)
    expect(JSON.parse(result.body)).toMatchObject({ error: 'PayloadTooLarge' })
    expect(result.routeCalls).toBe(0)
  })

  it('enforces the limit when Content-Length is absent', async () => {
    const result = await post(
      '/api/auth/login',
      Buffer.alloc(DEFAULT_BODY_LIMIT_BYTES + 1, 'a'),
      false
    )
    expect(result.status).toBe(413)
    expect(result.routeCalls).toBe(0)
  })

  it('allows the larger media envelope but still caps it', async () => {
    const allowed = await post('/api/media', Buffer.alloc(DEFAULT_BODY_LIMIT_BYTES + 1, 'a'))
    expect(allowed.status).toBe(200)
    expect(allowed.routeCalls).toBe(1)

    const rejected = await post('/api/media', Buffer.alloc(MEDIA_BODY_LIMIT_BYTES + 1, 'a'))
    expect(rejected.status).toBe(413)
    expect(rejected.routeCalls).toBe(0)
  })
})
