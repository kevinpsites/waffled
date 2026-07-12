import type { NextFunction, Request, Response } from 'lambda-api'

interface Bucket {
  count: number
  resetAt: number
}

interface Limit {
  scope: string
  key: string
  max: number
  windowMs: number
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 20_000
let checks = 0

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function clientAddress(req: Request): string {
  const sourceIp = (req as Request & {
    requestContext?: { identity?: { sourceIp?: unknown } }
  }).requestContext?.identity?.sourceIp
  if (typeof sourceIp === 'string' && sourceIp) return sourceIp
  return typeof req.ip === 'string' && req.ip ? req.ip : 'unknown'
}

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

function consume(limit: Limit, now: number): number | null {
  if (++checks % 500 === 0) sweep(now)
  const mapKey = `${limit.scope}:${limit.key}`
  const current = buckets.get(mapKey)
  if (current && current.resetAt > now) {
    if (current.count >= limit.max) {
      return Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    }
    current.count += 1
    return null
  }

  if (!current && buckets.size >= MAX_BUCKETS) {
    sweep(now)
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value as string | undefined
      if (oldest) buckets.delete(oldest)
    }
  }
  buckets.set(mapKey, { count: 1, resetAt: now + limit.windowMs })
  return null
}

function routeLimits(req: Request): Limit[] {
  const ip = clientAddress(req)
  const route = `${req.method.toUpperCase()} ${req.path}`
  switch (route) {
    case 'POST /api/auth/setup':
      return [{
        scope: 'auth-setup', key: ip,
        max: positiveInt('RATE_LIMIT_SETUP_MAX', 5), windowMs: 60 * 60_000,
      }]
    case 'POST /api/auth/login': {
      const email = String((req.body as { email?: unknown } | undefined)?.email ?? '')
        .trim()
        .toLowerCase() || '<missing>'
      return [
        {
          scope: 'auth-login-account', key: email,
          max: positiveInt('RATE_LIMIT_LOGIN_ACCOUNT_MAX', 10), windowMs: 15 * 60_000,
        },
        {
          scope: 'auth-login-ip', key: ip,
          max: positiveInt('RATE_LIMIT_LOGIN_IP_MAX', 50), windowMs: 15 * 60_000,
        },
      ]
    }
    case 'GET /api/auth/oidc/start':
      return [{
        scope: 'oidc-start', key: ip,
        max: positiveInt('RATE_LIMIT_OIDC_START_MAX', 30), windowMs: 5 * 60_000,
      }]
    case 'POST /api/auth/oidc/exchange':
      return [{
        scope: 'oidc-exchange', key: ip,
        max: positiveInt('RATE_LIMIT_OIDC_EXCHANGE_MAX', 20), windowMs: 5 * 60_000,
      }]
    case 'POST /api/auth/refresh':
      return [{
        scope: 'auth-refresh', key: ip,
        max: positiveInt('RATE_LIMIT_REFRESH_MAX', 60), windowMs: 5 * 60_000,
      }]
    case 'POST /api/kiosk/pair':
      return [{
        scope: 'kiosk-pair', key: ip,
        max: positiveInt('RATE_LIMIT_KIOSK_PAIR_MAX', 10), windowMs: 10 * 60_000,
      }]
    case 'POST /api/kiosk/device/token':
      return [{
        scope: 'kiosk-device-token', key: ip,
        max: positiveInt('RATE_LIMIT_KIOSK_TOKEN_MAX', 30), windowMs: 10 * 60_000,
      }]
    case 'POST /api/media':
      return [{
        scope: 'media-upload', key: ip,
        max: positiveInt('RATE_LIMIT_MEDIA_MAX', 30), windowMs: 60_000,
      }]
    default:
      return []
  }
}

export function sensitiveRouteRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now()
  for (const limit of routeLimits(req)) {
    const retryAfter = consume(limit, now)
    if (retryAfter !== null) {
      res
        .status(429)
        .header('Retry-After', String(retryAfter))
        .json({
          error: 'TooManyRequests',
          message: 'Too many requests. Try again soon.',
          retryAfter,
        })
      return
    }
  }
  next()
}
