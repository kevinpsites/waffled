// OAuth clients for MCP connectors, both ways Claude identifies itself: Dynamic Client
// Registration (RFC 7591, a row in oauth_clients) and Client ID Metadata Documents (the
// client_id is an https URL we fetch). Every client is public: PKCE, no secret.
import { randomBytes } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import https from 'node:https'
import net from 'node:net'
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'

type Api = ReturnType<typeof createAPI>

export interface OAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  kind: 'registered' | 'metadata-document'
}

// Never-authorized registrations older than this are deleted; Claude registers anew on
// every fresh connection, so they pile up otherwise.
const UNUSED_CLIENT_DAYS = 7
const MAX_REDIRECT_URIS = 10
const MAX_NAME = 200
const CIMD_TIMEOUT_MS = 5000
const CIMD_MAX_BYTES = 64 * 1024
const CIMD_DEFAULT_TTL = 300
const CIMD_MAX_TTL = 86400

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)
}

// https anywhere, http only on a loopback host (a native app's local listener).
export function validRedirectUri(raw: unknown): boolean {
  const u = parseUrl(raw)
  if (!u || u.hash || u.username || u.password) return false
  return u.protocol === 'https:' || isLoopback(u)
}

// Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3): the
// native client picks a free one at run time.
export function redirectAllowed(registered: string[], requested: string): boolean {
  const want = parseUrl(requested)
  if (!want || !validRedirectUri(requested)) return false
  return registered.some((r) => {
    if (r === requested) return true
    const have = parseUrl(r)
    if (!have || !isLoopback(have) || !isLoopback(want)) return false
    return have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search
  })
}

// Addresses a metadata document may never be fetched from: anything that is not plainly
// on the public internet. IPv4-mapped and NAT64 IPv6 are refused outright rather than
// unwrapped, since no public client publishes those.
const BLOCKED = new net.BlockList()
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net4, bits, 'ipv4')
for (const [net6, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(net6, bits, 'ipv6')

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 0) return false
  // BlockList treats an IPv4 rule as covering its IPv4-mapped form too, so a mapped
  // address cannot be listed as a v6 subnet without also blocking every v4 address.
  if (family === 6 && /^::ffff:/i.test(ip)) return false
  return !BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

// Cache lifetime from a Cache-Control header, clamped; 0 means do not cache.
export function cacheSeconds(cacheControl: string | null | undefined): number {
  if (!cacheControl) return CIMD_DEFAULT_TTL
  const cc = cacheControl.toLowerCase()
  if (/\b(no-store|no-cache|private)\b/.test(cc)) return 0
  const m = /\bmax-age=(\d+)/.exec(cc)
  if (!m) return CIMD_DEFAULT_TTL
  return Math.min(Number(m[1]), CIMD_MAX_TTL)
}

export type MetadataFetcher = (url: string) => Promise<{ status: number; body: string; cacheControl?: string | null }>

// The resolver runs inside the connection, so the address checked is the address dialed:
// a hostname that re-resolves to 127.0.0.1 between a check and a fetch cannot slip by.
function safeLookup(
  hostname: string,
  options: { all?: boolean },
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, '')
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EREFUSED' }), '')
    }
    if (options.all) return cb(null, addresses)
    cb(null, addresses[0].address, addresses[0].family)
  })
}

const httpsFetcher: MetadataFetcher = (url) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const literal = u.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(literal) && !isPublicAddress(literal)) return reject(new Error('non-public address'))
    const req = https.get(
      u,
      { lookup: safeLookup as never, timeout: CIMD_TIMEOUT_MS, headers: { accept: 'application/json', 'user-agent': 'Waffled (MCP client metadata fetch)' } },
      (res) => {
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > CIMD_MAX_BYTES) {
            req.destroy(new Error('client metadata document is too large'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cacheControl: res.headers['cache-control'] ?? null })
        )
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('client metadata document timed out')))
    req.on('error', reject)
  })

let fetcher: MetadataFetcher = httpsFetcher
const documentCache = new Map<string, { client: OAuthClient; expiresAt: number }>()

// Tests swap in a stub so nothing reaches the network; null restores the real one.
export function setClientMetadataFetcherForTest(f: MetadataFetcher | null): void {
  fetcher = f ?? httpsFetcher
  documentCache.clear()
}

export class ClientError extends Error {}

function isMetadataDocumentId(clientId: string): boolean {
  const u = parseUrl(clientId)
  return !!u && u.protocol === 'https:' && u.pathname !== '/' && !u.hash && !u.username
}

async function fetchMetadataDocument(clientId: string): Promise<OAuthClient> {
  const cached = documentCache.get(clientId)
  if (cached && cached.expiresAt > Date.now()) return cached.client

  let res: Awaited<ReturnType<MetadataFetcher>>
  // One deadline over the whole fetch: the socket timeout only measures idle gaps, so a
  // server trickling a byte at a time would otherwise hold the consent request open.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), CIMD_TIMEOUT_MS)
  })
  try {
    res = await Promise.race([fetcher(clientId), deadline])
  } catch (err) {
    throw new ClientError(`Could not fetch the client metadata document: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status !== 200) throw new ClientError(`The client metadata document answered ${res.status}`)
  if (Buffer.byteLength(res.body) > CIMD_MAX_BYTES) throw new ClientError('The client metadata document is too large')
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(res.body)
  } catch {
    throw new ClientError('The client metadata document is not JSON')
  }
  if (doc.client_id !== clientId) throw new ClientError('The client metadata document names a different client_id')
  const name = typeof doc.client_name === 'string' ? doc.client_name.trim().slice(0, MAX_NAME) : ''
  if (!name) throw new ClientError('The client metadata document has no client_name')
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []
  if (!uris.length || !uris.every(validRedirectUri)) throw new ClientError('The client metadata document has no valid redirect_uris')
  const method = doc.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') throw new ClientError('Only public clients (token_endpoint_auth_method "none") are supported')

  const client: OAuthClient = { clientId, clientName: name, redirectUris: uris as string[], kind: 'metadata-document' }
  const ttl = cacheSeconds(res.cacheControl)
  if (ttl > 0) documentCache.set(clientId, { client, expiresAt: Date.now() + ttl * 1000 })
  return client
}

// The client for a client_id, or a ClientError saying why there is none.
export async function resolveClient(clientId: string): Promise<OAuthClient> {
  if (!clientId) throw new ClientError('client_id is required')
  if (isMetadataDocumentId(clientId)) return fetchMetadataDocument(clientId)
  const { rows } = await query<{ client_id: string; client_name: string; redirect_uris: string[] }>(
    `select client_id, client_name, redirect_uris from oauth_clients where client_id = $1`,
    [clientId]
  )
  const r = rows[0]
  if (!r) throw new ClientError('Unknown client')
  return { clientId: r.client_id, clientName: r.client_name, redirectUris: r.redirect_uris, kind: 'registered' }
}

export async function markClientUsed(clientId: string): Promise<void> {
  await query(`update oauth_clients set last_used_at = now() where client_id = $1`, [clientId])
}

function registrationError(res: Response, error: string, description: string) {
  return res.status(400).json({ error, error_description: description })
}

export function registerClientRoutes(api: Api): void {
  // PUBLIC — RFC 7591 registration. JSON in, the registered metadata out.
  api.post('/api/oauth/register', async (req: Request, res: Response) => {
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
    const uris = b.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) {
      return registrationError(res, 'invalid_redirect_uri', 'redirect_uris must list https or loopback http URLs')
    }
    const method = b.token_endpoint_auth_method
    if (method !== undefined && method !== 'none') {
      return registrationError(res, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported')
    }
    const grantTypes = b.grant_types
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))) {
      return registrationError(res, 'invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token')
    }
    const named = typeof b.client_name === 'string' ? b.client_name.trim().slice(0, MAX_NAME) : ''
    const clientName = named || new URL(uris[0] as string).host

    await query(`delete from oauth_clients where last_used_at is null and created_at < now() - ($1 || ' days')::interval`, [
      String(UNUSED_CLIENT_DAYS),
    ])
    const clientId = `wfc_${randomBytes(18).toString('base64url')}`
    const { rows } = await query<{ created_at: Date }>(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ($1, $2, $3) returning created_at`,
      [clientId, clientName, uris]
    )
    return res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(rows[0].created_at.getTime() / 1000),
      client_name: clientName,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  })
}
