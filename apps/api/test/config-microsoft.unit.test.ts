// Microsoft config must treat present-but-EMPTY env vars as unset. Docker
// Compose passes optional vars through as "" (`MS_CALENDAR_SCOPES: ${MS_CALENDAR_SCOPES:-}`),
// and plain `??` keeps "", which sent scope="" to Microsoft's authorize endpoint
// → AADSTS900144 "request body must contain the following parameter: 'scope'".
import { describe, it, expect, beforeEach, vi } from 'vitest'

async function freshConfig(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return (await import('../src/platform/config')).config
}

beforeEach(() => {
  for (const k of ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_CALENDAR_REDIRECT_URI', 'MS_CALENDAR_SCOPES', 'MS_AUTH_URL', 'MS_TOKEN_URL', 'MS_GRAPH_BASE']) {
    delete process.env[k]
  }
})

describe('microsoft config vs compose empty-string passthrough', () => {
  it('falls back to default scopes when MS_CALENDAR_SCOPES is empty', async () => {
    const config = await freshConfig({ MS_CALENDAR_SCOPES: '' })
    expect(config.microsoft.scopes).toContain('Calendars.ReadWrite')
    expect(config.microsoft.scopes).toContain('offline_access')
  })

  it('falls back to real endpoints when the URL overrides are empty', async () => {
    const config = await freshConfig({ MS_AUTH_URL: '', MS_TOKEN_URL: '', MS_GRAPH_BASE: '' })
    expect(config.microsoft.authUrl).toContain('login.microsoftonline.com')
    expect(config.microsoft.tokenUrl).toContain('login.microsoftonline.com')
    expect(config.microsoft.graphBase).toContain('graph.microsoft.com')
  })

  it('treats empty client credentials as not configured', async () => {
    const config = await freshConfig({ MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', MS_CALENDAR_REDIRECT_URI: '' })
    expect(config.microsoft.clientId).toBeNull()
    expect(config.microsoft.clientSecret).toBeNull()
    expect(config.microsoft.redirectUri).toBeNull()
  })

  it('still honors real values when set', async () => {
    const config = await freshConfig({ MS_CALENDAR_SCOPES: 'openid Calendars.Read', MS_CLIENT_ID: 'abc' })
    expect(config.microsoft.scopes).toBe('openid Calendars.Read')
    expect(config.microsoft.clientId).toBe('abc')
  })
})
