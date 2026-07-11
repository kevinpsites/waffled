import http from 'node:http'
import { log } from './logger'

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024
export const MEDIA_BODY_LIMIT_BYTES = 14 * 1024 * 1024

interface RunResult {
  statusCode: number
  headers?: Record<string, string>
  body?: string
}

interface ApiRunner {
  run(event: unknown, context: unknown): unknown
}

function bodyLimit(path: string): number {
  return path === '/api/media' ? MEDIA_BODY_LIMIT_BYTES : DEFAULT_BODY_LIMIT_BYTES
}

function payloadTooLarge(res: http.ServerResponse, limit: number): void {
  const body = JSON.stringify({
    error: 'PayloadTooLarge',
    message: `Request body exceeds the ${Math.floor(limit / (1024 * 1024))} MB limit.`,
  })
  res.writeHead(413, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  res.end(body)
}

// Adapt Node requests to the API Gateway REST-v1 event shape used by lambda-api.
// Limits are enforced while streaming, before any Buffer.concat or JSON parsing.
export function createHttpServer(api: ApiRunner): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = bodyLimit(url.pathname)
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      payloadTooLarge(res, limit)
      req.resume()
      return
    }

    const chunks: Buffer[] = []
    let received = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      received += chunk.byteLength
      if (received > limit) {
        rejected = true
        chunks.length = 0
        payloadTooLarge(res, limit)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      if (rejected) return
      const event = {
        httpMethod: req.method,
        path: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: req.headers,
        requestContext: { identity: { sourceIp: req.socket.remoteAddress ?? 'unknown' } },
        body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
        isBase64Encoded: false,
      }
      try {
        const result = (await api.run(event, {})) as RunResult
        res.writeHead(result.statusCode, result.headers ?? {})
        res.end(result.body)
      } catch (err) {
        log.error('server adapter error', { err })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal', message: (err as Error).message }))
      }
    })
  })
}
