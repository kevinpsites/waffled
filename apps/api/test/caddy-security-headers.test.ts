import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const caddyfile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../infra/compose/caddy/Caddyfile'
)

describe('Caddy browser security headers', () => {
  it('sets baseline MIME, referrer, and browser capability policies', async () => {
    const config = await readFile(caddyfile, 'utf8')
    expect(config).toContain('X-Content-Type-Options "nosniff"')
    expect(config).toContain('Referrer-Policy "strict-origin-when-cross-origin"')
    expect(config).toContain('Permissions-Policy "camera=(self), microphone=(self), geolocation=()"')
  })

  it('uses a restrictive CSP that still supports Waffled runtime assets and sync', async () => {
    const config = await readFile(caddyfile, 'utf8')
    const policy = config.match(/Content-Security-Policy "([^"]+)"/)?.[1]
    expect(policy).toBeTruthy()
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("'wasm-unsafe-eval'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
    expect(policy).toContain("img-src 'self' data: blob: https:")
    expect(policy).toContain("connect-src 'self' http: https: ws: wss:")
    expect(policy).toContain("worker-src 'self' blob:")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("base-uri 'self'")
    expect(policy).toContain("form-action 'self'")
  })
})
