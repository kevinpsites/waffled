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
  /** Image bytes by recipe id; an unknown id answers 404. */
  images: Record<string, Buffer>
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

type Handler = (ctx: { fake: FakeMealie; method: string; url: URL; body: unknown; match: RegExpMatchArray }) =>
  | { status: number; body?: unknown; raw?: { contentType: string; bytes: Buffer } }
  | undefined

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
  {
    method: 'GET',
    pattern: /^\/api\/households\/mealplans$/,
    auth: true,
    handler: ({ fake, url }) => {
      const start = url.searchParams.get('start_date')
      const end = url.searchParams.get('end_date')
      const items = fake.state.mealplans.filter((m) => {
        const d = String(m.date)
        return (!start || d >= start) && (!end || d <= end)
      })
      return { status: 200, body: { page: 1, per_page: -1, total: items.length, total_pages: 1, items } }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/recipes$/,
    auth: true,
    handler: ({ fake, url }) => {
      const search = (url.searchParams.get('search') ?? '').toLowerCase()
      const page = Number(url.searchParams.get('page') ?? 1)
      const perPage = Number(url.searchParams.get('perPage') ?? 50)
      const all = fake.state.recipes.filter((r) => !search || String(r.name).toLowerCase().includes(search))
      const items = all.slice((page - 1) * perPage, page * perPage)
      return { status: 200, body: { page, per_page: perPage, total: all.length, total_pages: Math.max(1, Math.ceil(all.length / perPage)), items } }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/recipes\/([^/]+)$/,
    auth: true,
    handler: ({ fake, match }) => {
      const r = fake.state.recipes.find((x) => x.slug === match[1])
      return r ? { status: 200, body: r } : { status: 404, body: { detail: 'Not Found' } }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/media\/recipes\/([^/]+)\/images\/[^/]+\.webp$/,
    auth: false,
    handler: ({ fake, match }) => {
      const bytes = fake.state.images[match[1]]
      return bytes ? { status: 200, raw: { contentType: 'image/webp', bytes } } : { status: 404 }
    },
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
      images: {},
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
        if (out?.raw) { res.writeHead(out.status, { 'content-type': out.raw.contentType }); res.end(out.raw.bytes); return }
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
