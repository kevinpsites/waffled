// Component-level coverage of the local HS256 auth path. No container needed —
// this is the fast inner loop. The container-backed paths live in the other files.
import { describe, it, expect } from 'vitest'
import jwt, { type SignOptions } from 'jsonwebtoken'
import app from '../src/app'

const SECRET = 'nook-local-dev-secret-change-me' // matches config's local default

function mint(payload: object, opts: SignOptions = {}): string {
  return jwt.sign(payload, SECRET, {
    algorithm: 'HS256',
    issuer: 'nook-local',
    audience: 'nook-api',
    expiresIn: '1h',
    ...opts,
  })
}

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, headers: Record<string, string> = {}) {
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: null, isBase64Encoded: false } as never,
    {} as never
  ) as Promise<RunResult>
}

describe('auth — local HS256 mode', () => {
  it('GET /healthz is public and reports local mode', async () => {
    const res = await call('GET', '/healthz')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, authMode: 'local' })
  })

  it('rejects a request with no token (401)', async () => {
    const res = await call('GET', '/api/me')
    expect(res.statusCode).toBe(401)
  })

  it('rejects a malformed token (401)', async () => {
    const res = await call('GET', '/api/me', { authorization: 'Bearer not.a.jwt' })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a valid token and echoes the principal (DB-free)', async () => {
    const token = mint({}, { subject: 'dev|kevin' })
    const res = await call('GET', '/api/me', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ sub: 'dev|kevin' })
  })
})
