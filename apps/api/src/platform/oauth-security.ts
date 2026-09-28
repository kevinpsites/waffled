import type { Request, Response } from 'lambda-api'

export const OAUTH_RESULT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export function escapeOAuthHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]!)
}

// PUBLIC_BASE_URL is the canonical web origin in proxied deployments. The
// forwarded-header fallback preserves the existing self-hosted behavior when it
// is intentionally omitted.
export function oauthBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '')
  if (configured) return configured
  const headers = req.headers as Record<string, string | undefined>
  const protocol = headers['x-forwarded-proto'] ?? 'http'
  const host = headers['x-forwarded-host'] ?? headers.host ?? 'localhost:8080'
  return `${protocol}://${host}`
}

interface AllowedRedirectOptions {
  nativeRedirect: string
  webDestination: 'origin' | 'full'
}

// OAuth destinations are an allowlist, not a general return URL. Web callers
// may return only to the canonical Waffled origin; native callers must match one
// exact registered callback. Fragments and embedded credentials are rejected so
// the destination has one unambiguous interpretation.
export function allowedOAuthRedirect(
  req: Request,
  raw: string | null,
  options: AllowedRedirectOptions
): string | null {
  if (!raw) return null
  try {
    if (raw.startsWith('//')) return null
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    if (!raw.startsWith('/') && !hasScheme) return null

    const baseUrl = oauthBaseUrl(req)
    const url = new URL(raw, `${baseUrl}/`)
    if (url.username || url.password || url.hash) return null

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== new URL(baseUrl).origin) return null
      return options.webDestination === 'origin' ? `${url.origin}/` : url.toString()
    }

    const nativeRedirect = new URL(options.nativeRedirect)
    return url.toString() === nativeRedirect.toString() ? options.nativeRedirect : null
  } catch {
    return null
  }
}

export function secureOAuthResult(res: Response): Response {
  return res
    .header('Content-Security-Policy', OAUTH_RESULT_CSP)
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
}
