// In-process fake Mealie, shaped like the real API (see the Constraints table in
// docs/superpowers/specs/2026-11-24-mealie-design.md). Later tasks add routes and seed `state`.
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  method: string
  path: string
  body: unknown
  auth: string | null
}

export interface FakeMealieState {
  version: string
  recipes: Record<string, unknown>[]
  mealplans: Record<string, unknown>[]
  lists: { id: string; name: string }[]
  items: Record<string, unknown>[]
  requests: FakeRequest[]
  /** When true every connection is destroyed, simulating an unreachable Mealie. */
  down: boolean
}

export interface FakeMealie {
  url: string
  /** The Bearer token currently accepted; reassign to simulate a revoked token. */
  token: string
  state: FakeMealieState
  close: () => Promise<void>
}

type Handler = (ctx: { fake: FakeMealie; method: string; url: URL; body: unknown; match: RegExpMatchArray }) => { status: number; body?: unknown } | undefined

interface Route {
  method: string
  pattern: RegExp
  auth: boolean
  handler: Handler
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/app\/about$/,
    auth: false,
    handler: ({ fake }) => ({ status: 200, body: { version: fake.state.version, production: true } }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/users\/self$/,
    auth: true,
    handler: () => ({ status: 200, body: { id: 'u1', username: 'waffled', email: 'waffled@example.com' } }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/households\/shopping\/lists$/,
    auth: true,
    handler: ({ fake }) => ({
      status: 200,
      body: { page: 1, per_page: 50, total: fake.state.lists.length, total_pages: 1, items: fake.state.lists },
    }),
  },
]

export async function startFakeMealie(): Promise<FakeMealie> {
  const sockets = new Set<import('node:net').Socket>()
  const fake: FakeMealie = {
    url: '',
    token: 'fake-mealie-api-token',
    state: {
      version: '3.29.0',
      recipes: [],
      mealplans: [],
      lists: [{ id: 'list-1', name: 'Groceries' }, { id: 'list-2', name: 'Costco' }],
      items: [],
      requests: [],
      down: false,
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }

  const server = http.createServer((req, res) => {
    if (fake.state.down) {
      req.socket.destroy()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const method = req.method ?? 'GET'
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = undefined
      if (raw) {
        try { body = JSON.parse(raw) } catch { body = raw }
      }
      const auth = req.headers.authorization ?? null
      fake.state.requests.push({ method, path: url.pathname + url.search, body, auth })

      const send = (status: number, payload?: unknown) => {
        if (payload === undefined) { res.writeHead(status); res.end(); return }
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      for (const r of routes) {
        if (r.method !== method) continue
        const match = url.pathname.match(r.pattern)
        if (!match) continue
        if (r.auth && auth !== `Bearer ${fake.token}`) return send(401, { detail: 'Unauthorized' })
        const out = r.handler({ fake, method, url, body, match })
        if (out) return send(out.status, out.body)
      }
      send(404, { detail: 'Not Found' })
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    if (fake.state.down) s.destroy()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}
