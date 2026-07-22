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
