// The bind address must be configurable: the native ("Waffled for Mac") runtime has no
// Docker network to hide the API behind, so it pins the process to loopback via HOST.
// Unset HOST must keep the historical behaviour (all interfaces) so Compose and the demo
// box are unaffected.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createHttpServer, listen } from '../src/platform/http-server'

async function freshConfig(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return (await import('../src/platform/config')).config
}

const noopApi = { run: async () => ({ statusCode: 204 }) }
const servers: Server[] = []

beforeEach(() => {
  delete process.env.HOST
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

function bound(server: Server): AddressInfo {
  return server.address() as AddressInfo
}

describe('config.host', () => {
  it('is undefined when HOST is unset or empty (Compose passes optional vars as "")', async () => {
    expect((await freshConfig({})).host).toBeUndefined()
    expect((await freshConfig({ HOST: '' })).host).toBeUndefined()
  })

  it('reads HOST when set', async () => {
    expect((await freshConfig({ HOST: '127.0.0.1' })).host).toBe('127.0.0.1')
  })
})

describe('listen(server, { port, host })', () => {
  it('binds only the given host when one is set', async () => {
    const server = createHttpServer(noopApi)
    servers.push(server)
    const addr = await listen(server, { port: 0, host: '127.0.0.1' })
    expect(addr.address).toBe('127.0.0.1')
    expect(bound(server).address).toBe('127.0.0.1')
    expect(bound(server).port).toBeGreaterThan(0)
  })

  it('keeps binding all interfaces when host is unset', async () => {
    const server = createHttpServer(noopApi)
    servers.push(server)
    const addr = await listen(server, { port: 0, host: undefined })
    expect(['::', '0.0.0.0']).toContain(addr.address)
    expect(addr.port).toBeGreaterThan(0)
  })
})
