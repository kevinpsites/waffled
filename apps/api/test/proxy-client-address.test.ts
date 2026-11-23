import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpServer, listen } from '../src/platform/http-server'

let server: http.Server | undefined

async function sourceIpSeenByApi(trustProxy: boolean, forwardedFor: string): Promise<string> {
  const api = {
    run: (event: unknown) => ({
      statusCode: 200,
      body: (event as { requestContext: { identity: { sourceIp: string } } }).requestContext.identity.sourceIp,
    }),
  }
  server = createHttpServer(api, { trustProxy })
  const { port } = (await listen(server, { port: 0, host: '127.0.0.1' })) as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
    headers: { 'x-forwarded-for': forwardedFor },
  })
  return res.text()
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

describe('client address behind a proxy', () => {
  it('ignores X-Forwarded-For when TRUST_PROXY is off', async () => {
    expect(await sourceIpSeenByApi(false, '198.51.100.7')).not.toBe('198.51.100.7')
  })

  it('honours X-Forwarded-For when TRUST_PROXY is on', async () => {
    expect(await sourceIpSeenByApi(true, '198.51.100.7')).toBe('198.51.100.7')
  })

  it('falls back to the socket address when the forwarded value is not an IP', async () => {
    expect(await sourceIpSeenByApi(true, 'not-an-ip')).not.toBe('not-an-ip')
  })
})
