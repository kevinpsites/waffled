import type http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export interface StaticOptions {
  webRoot?: string
  mediaRoot?: string
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_CACHE_FILES = new Set(['/index.html', '/sw.js', '/asset-manifest.json'])

function isApiPath(p: string): boolean {
  return p === '/healthz' || p === '/api' || p.startsWith('/api/') || p === '/auth' || p.startsWith('/auth/')
}

// Resolve a request path under root; null when it escapes the root or is malformed.
function within(root: string, rel: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const base = resolve(root)
  const full = resolve(base, '.' + (decoded.startsWith('/') ? decoded : `/${decoded}`))
  return full.startsWith(base + sep) ? full : null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  cacheControl: string,
): Promise<void> {
  const body = await readFile(path)
  res.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': cacheControl,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'NotFound' }))
}

/** Serve the SPA and uploaded media. Resolves true when the response was handled. */
export async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: StaticOptions,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (isApiPath(pathname)) return false

  if (pathname.startsWith('/media/')) {
    if (!opts.mediaRoot) return false
    const file = within(opts.mediaRoot, pathname.slice('/media'.length))
    if (!file || !(await isFile(file))) {
      notFound(res)
      return true
    }
    await send(req, res, file, IMMUTABLE)
    return true
  }

  if (!opts.webRoot) return false
  const file = within(opts.webRoot, pathname)
  if (file && (await isFile(file))) {
    const rel = '/' + file.slice(resolve(opts.webRoot).length + 1).split(sep).join('/')
    const cache = NO_CACHE_FILES.has(rel) ? 'no-cache' : rel.startsWith('/assets/') ? IMMUTABLE : 'public, max-age=3600'
    await send(req, res, file, cache)
    return true
  }
  // A stale tab asking for an old hashed bundle must get a 404, not index.html served as JS.
  if (pathname.startsWith('/assets/')) {
    notFound(res)
    return true
  }
  const index = resolve(opts.webRoot, 'index.html')
  if (!(await isFile(index))) return false
  await send(req, res, index, 'no-cache')
  return true
}
