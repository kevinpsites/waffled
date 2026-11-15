import { createHash } from 'node:crypto'
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
  // An OAuth endpoint answers in RFC 6749's error shape, which its clients parse.
  oauth?: boolean
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

const mapKey = (limit: Limit) => `${limit.scope}:${limit.key}`

// Seconds to wait if this limit is spent, else null. Reads only.
function retryAfter(limit: Limit, now: number): number | null {
  const current = buckets.get(mapKey(limit))
  if (current && current.resetAt > now && current.count >= limit.max) {
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  }
  return null
}

function charge(limit: Limit, now: number): void {
  if (++checks % 500 === 0) sweep(now)
  const key = mapKey(limit)
  const current = buckets.get(key)
  if (current && current.resetAt > now) {
    current.count += 1
    return
  }

  if (!current && buckets.size >= MAX_BUCKETS) {
    sweep(now)
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value as string | undefined
      if (oldest) buckets.delete(oldest)
    }
  }
  buckets.set(key, { count: 1, resetAt: now + limit.windowMs })
}

export function routeLimits(req: Request): Limit[] {
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
    // Public. A connector exchanges a code once and refreshes about hourly. client_id is
    // unauthenticated input, so the address bucket stops rotating it to dodge the first.
    case 'POST /api/oauth/token': {
      const raw = (req.body as { client_id?: unknown } | undefined)?.client_id
      // Hashed so an unbounded input can't grow the shared bucket map's keys.
      const clientId = typeof raw === 'string' && raw
        ? createHash('sha256').update(raw).digest('hex').slice(0, 16)
        : '<missing>'
      return [
        {
          scope: 'oauth-token-client', key: `${ip}|${clientId}`, oauth: true,
          max: positiveInt('RATE_LIMIT_OAUTH_TOKEN_MAX', 30), windowMs: 10 * 60_000,
        },
        {
          scope: 'oauth-token-ip', key: ip, oauth: true,
          max: positiveInt('RATE_LIMIT_OAUTH_TOKEN_IP_MAX', 300), windowMs: 10 * 60_000,
        },
      ]
    }
    // Unauthenticated and writes a row; Claude registers once per new connection.
    case 'POST /api/oauth/register':
      return [{
        scope: 'oauth-register', key: ip,
        max: positiveInt('RATE_LIMIT_OAUTH_REGISTER_MAX', 30), windowMs: 10 * 60_000,
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
  const limits = routeLimits(req)
  // Every bucket is checked before any is charged, so a refused request costs nothing.
  for (const limit of limits) {
    const wait = retryAfter(limit, now)
    if (wait !== null && limit.oauth) {
      res
        .status(429)
        .header('Retry-After', String(wait))
        .header('Cache-Control', 'no-store')
        .json({ error: 'temporarily_unavailable', error_description: `Too many token requests. Retry after ${wait} seconds.` })
      return
    }
    if (wait !== null) {
      res
        .status(429)
        .header('Retry-After', String(wait))
        .json({
          error: 'TooManyRequests',
          message: 'Too many requests. Try again soon.',
          retryAfter: wait,
        })
      return
    }
  }
  for (const limit of limits) charge(limit, now)
  next()
}

// Per caller, checked by /mcp after authentication (this middleware runs before it): the
// caller is the API key, the connector grant, or the signed-in subject. Returns the
// seconds to wait when over the limit, else null.
export function mcpToolCallRetryAfter(caller: string): number | null {
  const limit = {
    scope: 'mcp-tool-call', key: caller,
    max: positiveInt('RATE_LIMIT_MCP_CALL_MAX', 120), windowMs: 60_000,
  }
  const now = Date.now()
  const wait = retryAfter(limit, now)
  if (wait === null) charge(limit, now)
  return wait
}
