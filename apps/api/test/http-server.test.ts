import { describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { type AddressInfo } from 'node:net'
import {
  createHttpServer,
  DEFAULT_BODY_LIMIT_BYTES,
  MEDIA_BODY_LIMIT_BYTES,
  INGEST_BODY_LIMIT_BYTES,
} from '../src/platform/http-server'

interface CapturedEvent {
  requestContext?: { identity?: { sourceIp?: string } }
}

async function post(
  path: string,
  body: Buffer,
  includeLength = true,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; routeCalls: number; event?: CapturedEvent }> {
  let capturedEvent: CapturedEvent | undefined
  const app = {
    run: vi.fn(async (event: unknown) => {
      capturedEvent = event as CapturedEvent
      return { statusCode: 200, body: JSON.stringify({ ok: true }) }
    }),
  }
  const server = createHttpServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return new Promise((resolve, reject) => {
    let settled = false
    let status = 0
    const chunks: Buffer[] = []
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      const result = {
        status,
        body: Buffer.concat(chunks).toString('utf8'),
        routeCalls: app.run.mock.calls.length,
        event: capturedEvent,
      }
      server.close(() => (error ? reject(error) : resolve(result)))
    }

    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(includeLength ? { 'content-length': body.byteLength } : {}),
        ...headers,
      },
    }, (res) => {
      status = res.statusCode ?? 0
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => finish())
      // A reset that arrives after the headers still leaves a usable status.
      res.on('close', () => finish())
    })
    // The server answers an over-limit body with `connection: close` before the upload
    // finishes, so the remainder hits a socket it already destroyed. ECONNRESET/EPIPE
    // here is that expected teardown, not a failure: keep the response we received.
    req.on('error', (error: NodeJS.ErrnoException) => {
      const expectedTeardown = error.code === 'ECONNRESET' || error.code === 'EPIPE'
      if (status !== 0 && expectedTeardown) return finish()
      finish(error)
    })

    // Upload in chunks and stop as soon as the server has answered. A real client does
    // not keep pushing a body into a response it has already received, and continuing
    // to write into the socket the server closed behind its 413 is precisely what threw
    // ECONNRESET and failed this suite at random.
    const CHUNK_BYTES = 64 * 1024
    let offset = 0
    const pump = (): void => {
      if (settled || req.destroyed) return
      if (status !== 0 || offset >= body.byteLength) {
        req.end()
        return
      }
      const slice = body.subarray(offset, offset + CHUNK_BYTES)
      offset += CHUNK_BYTES
      req.write(slice, () => setImmediate(pump))
    }
    pump()
  })
}

// Prove an over-limit body is capped WITHOUT transmitting it. createHttpServer rejects
// on the declared Content-Length before reading a single byte, so a token body with an
// over-limit declared length exercises exactly that branch — deterministically, in
// milliseconds, and without allocating tens of megabytes.
//
// Streaming the real payload used to be the way these cases were written, and it was
// flaky: the server answers 413 with `connection: close` and tears the socket down
// while the upload is still in flight, so under load the client's write died with
// ECONNRESET before the response landed. That is a race in the client, not a defect in
// the cap, and it failed releases at random. The streaming branch (`received > limit`)
// stays covered by the no-Content-Length case below, which is shared code.
function postDeclaring(path: string, declaredLength: number) {
  return post(path, Buffer.alloc(1024, 'a'), false, {
    'content-length': String(declaredLength),
  })
}

describe('Node HTTP request body limits', () => {
  it('rejects an oversized ordinary JSON body before route handling', async () => {
    const result = await postDeclaring('/api/auth/login', DEFAULT_BODY_LIMIT_BYTES + 1)
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

  it('applies the per-path limit, not the default, when Content-Length is absent', async () => {
    // The streaming branch counts bytes as they arrive and must compare them against the
    // limit for *this* path. Every other streaming assertion uses /api/auth/login, whose
    // limit is the default — so a streaming branch that ignored the path and always
    // compared against DEFAULT_BODY_LIMIT_BYTES would pass the whole suite while
    // 413-ing every real photo upload. A body over the default but well under the media
    // limit has to reach the route.
    const result = await post('/api/media', Buffer.alloc(DEFAULT_BODY_LIMIT_BYTES + 1, 'a'), false)
    expect(result.status).toBe(200)
    expect(result.routeCalls).toBe(1)
  })

  it('allows the larger media envelope but still caps it', async () => {
    const allowed = await post('/api/media', Buffer.alloc(DEFAULT_BODY_LIMIT_BYTES + 1, 'a'))
    expect(allowed.status).toBe(200)
    expect(allowed.routeCalls).toBe(1)

    const rejected = await postDeclaring('/api/media', MEDIA_BODY_LIMIT_BYTES + 1)
    expect(rejected.status).toBe(413)
    expect(rejected.routeCalls).toBe(0)
  })

  it('allows the multi-photo recipe-ingest envelope but still caps it', async () => {
    // Recipe photo-import bundles up to MAX_INGEST_PHOTOS base64 images in one
    // JSON body, so it legitimately exceeds the 1 MB default. Regression guard: a
    // >1 MB ingest body must reach the route, not 413 like an ordinary request.
    const allowed = await post(
      '/api/recipes/ingest/photo',
      Buffer.alloc(DEFAULT_BODY_LIMIT_BYTES + 1, 'a')
    )
    expect(allowed.status).toBe(200)
    expect(allowed.routeCalls).toBe(1)

    const rejected = await postDeclaring(
      '/api/recipes/ingest/photo',
      INGEST_BODY_LIMIT_BYTES + 1
    )
    expect(rejected.status).toBe(413)
    expect(rejected.routeCalls).toBe(0)
  })

  it('records the single client address supplied by the trusted proxy', async () => {
    const result = await post(
      '/api/auth/login',
      Buffer.from('{}'),
      true,
      { 'x-forwarded-for': '198.51.100.42' }
    )
    expect(result.event?.requestContext?.identity?.sourceIp).toBe('198.51.100.42')
  })

  it('rejects forwarding chains that have not been normalized by the proxy', async () => {
    const result = await post(
      '/api/auth/login',
      Buffer.from('{}'),
      true,
      { 'x-forwarded-for': '198.51.100.42, 203.0.113.8' }
    )
    expect(result.event?.requestContext?.identity?.sourceIp).not.toBe('198.51.100.42')
  })
})
