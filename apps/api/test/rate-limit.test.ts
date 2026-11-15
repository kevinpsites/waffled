import type { NextFunction, Request, Response } from 'lambda-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeLimits, sensitiveRouteRateLimit } from '../src/platform/rate-limit'

afterEach(() => delete process.env.RATE_LIMIT_REFRESH_MAX)

function attempt(forwardedIp: string) {
  const req = {
    method: 'POST',
    path: '/api/auth/refresh',
    ip: forwardedIp,
    requestContext: { identity: { sourceIp: '192.0.2.77' } },
  } as unknown as Request
  const json = vi.fn()
  const response = {
    status: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response
  const next = vi.fn() as unknown as NextFunction

  sensitiveRouteRateLimit(req, response, next)
  return { json, next }
}

describe('sensitive route client address', () => {
  it('does not let a caller rotate the bucket with spoofed forwarding headers', () => {
    process.env.RATE_LIMIT_REFRESH_MAX = '2'

    expect(attempt('198.51.100.1').next).toHaveBeenCalledOnce()
    expect(attempt('198.51.100.2').next).toHaveBeenCalledOnce()
    expect(attempt('198.51.100.3').json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TooManyRequests' })
    )
  })
})

describe('OAuth client registration', () => {
  afterEach(() => delete process.env.RATE_LIMIT_OAUTH_REGISTER_MAX)

  it('is rate limited per address, since it writes a row before any sign-in', () => {
    process.env.RATE_LIMIT_OAUTH_REGISTER_MAX = '1'
    const register = () => {
      const req = { method: 'POST', path: '/api/oauth/register', ip: '198.51.100.9' } as unknown as Request
      const json = vi.fn()
      const res = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), json } as unknown as Response
      const next = vi.fn() as unknown as NextFunction
      sensitiveRouteRateLimit(req, res, next)
      return { json, next }
    }
    expect(register().next).toHaveBeenCalledOnce()
    expect(register().json).toHaveBeenCalledWith(expect.objectContaining({ error: 'TooManyRequests' }))
  })
})

describe('OAuth token endpoint', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_OAUTH_TOKEN_MAX
    delete process.env.RATE_LIMIT_OAUTH_TOKEN_IP_MAX
  })

  const tokenRequest = (ip: string, clientId: unknown) =>
    ({ method: 'POST', path: '/api/oauth/token', ip, body: { client_id: clientId } }) as unknown as Request

  function token(ip: string, clientId: unknown) {
    const json = vi.fn()
    const res = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), json } as unknown as Response
    const next = vi.fn() as unknown as NextFunction
    sensitiveRouteRateLimit(tokenRequest(ip, clientId), res, next)
    return { json, next }
  }
  const limited = expect.objectContaining({ error: 'temporarily_unavailable' })

  it('keys the client bucket on a short hash, whatever size client_id arrives', () => {
    const huge = 'x'.repeat(10_240)
    for (const limit of routeLimits(tokenRequest('198.51.100.20', huge))) {
      expect(limit.key.length).toBeLessThan(64)
    }
    process.env.RATE_LIMIT_OAUTH_TOKEN_MAX = '1'
    expect(token('198.51.100.20', huge).next).toHaveBeenCalledOnce()
    expect(token('198.51.100.20', huge).json).toHaveBeenCalledWith(limited)
    expect(token('198.51.100.20', `${huge}y`).next).toHaveBeenCalledOnce()
  })

  it('treats a non-string client_id as missing', () => {
    process.env.RATE_LIMIT_OAUTH_TOKEN_MAX = '1'
    expect(token('198.51.100.21', ['a', 'b']).next).toHaveBeenCalledOnce()
    expect(token('198.51.100.21', { nested: true }).json).toHaveBeenCalledWith(limited)
    expect(token('198.51.100.21', undefined).json).toHaveBeenCalledWith(limited)
  })

  it('does not charge the client bucket for a request the address bucket refuses', () => {
    process.env.RATE_LIMIT_OAUTH_TOKEN_MAX = '3'
    process.env.RATE_LIMIT_OAUTH_TOKEN_IP_MAX = '2'
    expect(token('198.51.100.22', 'client-a').next).toHaveBeenCalledOnce()
    expect(token('198.51.100.22', 'client-a').next).toHaveBeenCalledOnce()
    for (let i = 0; i < 3; i++) expect(token('198.51.100.22', 'client-a').json).toHaveBeenCalledWith(limited)
    // Only the two admitted requests count against client-a.
    process.env.RATE_LIMIT_OAUTH_TOKEN_IP_MAX = '100'
    expect(token('198.51.100.22', 'client-a').next).toHaveBeenCalledOnce()
    expect(token('198.51.100.22', 'client-a').json).toHaveBeenCalledWith(limited)
  })
})
