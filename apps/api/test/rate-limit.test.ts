import type { NextFunction, Request, Response } from 'lambda-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sensitiveRouteRateLimit } from '../src/platform/rate-limit'

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
