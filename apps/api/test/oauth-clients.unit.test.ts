// Pure helpers behind OAuth client registration: which addresses a Client ID Metadata
// Document may be fetched from, and which redirect URIs match a registration.
import { describe, it, expect, vi } from 'vitest'
import { isPublicAddress, redirectAllowed, validRedirectUri, cacheSeconds } from '../src/modules/oauth/clients'

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local, CGNAT and other reserved ranges', () => {
    for (const ip of [
      '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.10', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::5', '::ffff:127.0.0.1',
      '::ffff:7f00:1', '64:ff9b::a00:1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('accepts ordinary public addresses', () => {
    for (const ip of ['160.79.104.10', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })

  it('refuses anything that is not an IP', () => {
    expect(isPublicAddress('claude.ai')).toBe(false)
  })
})

describe('validRedirectUri', () => {
  it('takes https anywhere and http only on loopback', () => {
    expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(validRedirectUri('http://localhost:3000/cb')).toBe(true)
    expect(validRedirectUri('http://127.0.0.1/cb')).toBe(true)
    expect(validRedirectUri('http://[::1]:9/cb')).toBe(true)
    expect(validRedirectUri('http://example.com/cb')).toBe(false)
    expect(validRedirectUri('javascript:alert(1)')).toBe(false)
    expect(validRedirectUri('https://claude.ai/cb#frag')).toBe(false)
    expect(validRedirectUri('not a url')).toBe(false)
  })
})

describe('redirectAllowed', () => {
  it('matches https redirects exactly', () => {
    const reg = ['https://claude.ai/api/mcp/auth_callback']
    expect(redirectAllowed(reg, 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectAllowed(reg, 'https://claude.ai/api/mcp/auth_callback/')).toBe(false)
    expect(redirectAllowed(reg, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false)
    expect(redirectAllowed(reg, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false)
  })

  it('lets only the port vary on a loopback redirect (RFC 8252)', () => {
    const reg = ['http://localhost/callback', 'http://127.0.0.1:1234/callback']
    expect(redirectAllowed(reg, 'http://localhost:53682/callback')).toBe(true)
    expect(redirectAllowed(reg, 'http://127.0.0.1:9999/callback')).toBe(true)
    expect(redirectAllowed(reg, 'http://localhost:53682/other')).toBe(false)
    expect(redirectAllowed(reg, 'http://[::1]:53682/callback')).toBe(false)
    expect(redirectAllowed(reg, 'https://localhost:53682/callback')).toBe(false)
  })
})

describe('cacheSeconds', () => {
  it('honors max-age within bounds and never caches no-store', () => {
    expect(cacheSeconds('max-age=600')).toBe(600)
    expect(cacheSeconds('public, max-age=999999')).toBe(86400)
    expect(cacheSeconds('no-store')).toBe(0)
    expect(cacheSeconds('no-cache, max-age=600')).toBe(0)
    expect(cacheSeconds(null)).toBe(300)
  })
})

describe('the real metadata-document fetcher', () => {
  it('refuses a loopback literal and a name that resolves to loopback before connecting', async () => {
    const { resolveClient } = await import('../src/modules/oauth/clients')
    await expect(resolveClient('https://127.0.0.1/meta')).rejects.toThrow(/non-public/)
    await expect(resolveClient('https://[::1]/meta')).rejects.toThrow(/non-public/)
    await expect(resolveClient('https://localhost/meta')).rejects.toThrow(/non-public/)
  })
})

describe('the metadata-document deadline', () => {
  it('gives up after 5 seconds overall, even on a fetch that trickles or hangs', async () => {
    const { resolveClient, setClientMetadataFetcherForTest } = await import('../src/modules/oauth/clients')
    vi.useFakeTimers()
    setClientMetadataFetcherForTest(() => new Promise(() => {}))
    try {
      const pending = resolveClient('https://slow.example/meta')
      const settled = expect(pending).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(5001)
      await settled
    } finally {
      setClientMetadataFetcherForTest(null)
      vi.useRealTimers()
    }
  })
})

describe('the metadata-document cache', () => {
  it('holds at most 500 documents, dropping the oldest first', async () => {
    const { resolveClient, setClientMetadataFetcherForTest } = await import('../src/modules/oauth/clients')
    const fetched: string[] = []
    setClientMetadataFetcherForTest(async (url) => {
      fetched.push(url)
      return { status: 200, cacheControl: 'max-age=600', body: JSON.stringify({ client_id: url, client_name: 'C', redirect_uris: ['https://c.example/cb'] }) }
    })
    try {
      const url = (i: number) => `https://c.example/m/${i}`
      for (let i = 0; i <= 500; i++) await resolveClient(url(i))
      fetched.length = 0
      await resolveClient(url(500))
      await resolveClient(url(1))
      expect(fetched).toEqual([])
      await resolveClient(url(0))
      expect(fetched).toEqual([url(0)])
    } finally {
      setClientMetadataFetcherForTest(null)
    }
  })
})

describe('consent copy', () => {
  it('describes every grantable scope in plain words', async () => {
    const { ALL_SCOPES } = await import('../src/modules/api-keys/api-keys')
    const { SCOPE_DESCRIPTIONS } = await import('../src/modules/oauth/metadata')
    expect(ALL_SCOPES.filter((s) => !SCOPE_DESCRIPTIONS[s])).toEqual([])
  })
})
