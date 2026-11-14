// The /mcp endpoint: stateless MCP Streamable-HTTP JSON-RPC over the normal auth gate,
// driven through real routes against a throwaway Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startMcpHarness, bearer, keyed, json, header, type McpHarness } from './helpers/mcp'

let h: McpHarness
let kevin = ''
let householdId = ''
let ownerId = ''
const run: McpHarness['run'] = (...a) => h.run(...a)
const call: McpHarness['call'] = (...a) => h.call(...a)
const rpc: McpHarness['rpc'] = (...a) => h.rpc(...a)
const mintKey = (name: string, scopes: string[]) => h.mintKey(kevin, name, scopes)

beforeAll(async () => {
  h = await startMcpHarness()
  kevin = h.owner
  householdId = h.householdId
  ownerId = h.ownerId
})

afterAll(async () => {
  await h?.close()
})

describe('transport', () => {
  it('401s without credentials, as JSON', async () => {
    const res = await rpc({}, 'ping')
    expect(res.statusCode).toBe(401)
    expect(json(res).error).toBe('AuthError')
  })

  it('initialize echoes a supported protocol version and names the server', async () => {
    const res = await rpc(bearer(kevin), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(res.statusCode).toBe(200)
    expect(header(res, 'content-type')).toMatch(/application\/json/)
    const body = json(res)
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1 })
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.capabilities).toEqual({ tools: {} })
    expect(body.result.serverInfo.name).toBe('waffled')
    const { version } = await import('../src/platform/version')
    expect(body.result.serverInfo.version).toBe(version.pkg)
  })

  it('initialize answers our latest version for one it does not support', async () => {
    const res = await rpc(bearer(kevin), 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }, 'init-2')
    expect(json(res)).toMatchObject({ id: 'init-2', result: { protocolVersion: '2025-11-25' } })
  })

  it('accepts notifications and client responses with 202 and no body', async () => {
    const note = await run('POST', '/mcp', bearer(kevin), { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.statusCode).toBe(202)
    expect(note.body).toBe('')
    const response = await run('POST', '/mcp', bearer(kevin), { jsonrpc: '2.0', id: 9, result: {} })
    expect(response.statusCode).toBe(202)
    expect(response.body).toBe('')
  })

  it('answers ping with an empty result', async () => {
    expect(json(await rpc(bearer(kevin), 'ping', undefined, 7))).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('unknown method is -32601', async () => {
    const body = json(await rpc(bearer(kevin), 'resources/list'))
    expect(body.error.code).toBe(-32601)
    expect(body.id).toBe(1)
  })

  it('unparseable JSON is -32700, a bad envelope is -32600', async () => {
    const parse = await run('POST', '/mcp', bearer(kevin), undefined, '{not json')
    expect(parse.statusCode).toBe(400)
    expect(json(parse)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })

    const wrongVersion = await run('POST', '/mcp', bearer(kevin), { jsonrpc: '1.0', id: 1, method: 'ping' })
    expect(wrongVersion.statusCode).toBe(400)
    expect(json(wrongVersion).error.code).toBe(-32600)

    const noMethod = await run('POST', '/mcp', bearer(kevin), { jsonrpc: '2.0', id: 1 })
    expect(json(noMethod).error.code).toBe(-32600)

    const badId = await run('POST', '/mcp', bearer(kevin), { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })
    expect(json(badId).error.code).toBe(-32600)
  })

  it('rejects a JSON-RPC batch with -32600 (batching was dropped in 2025-06-18)', async () => {
    const res = await run('POST', '/mcp', bearer(kevin), [{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    expect(res.statusCode).toBe(400)
    expect(json(res)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } })
  })

  it('GET /mcp is 405 — a stateless server opens no SSE stream', async () => {
    const res = await run('GET', '/mcp', bearer(kevin))
    expect(res.statusCode).toBe(405)
    expect(header(res, 'allow')).toBe('POST')
  })

  it('400s an unsupported MCP-Protocol-Version header; a supported or absent one passes', async () => {
    const bad = await rpc({ ...bearer(kevin), 'mcp-protocol-version': '1999-01-01' }, 'ping')
    expect(bad.statusCode).toBe(400)
    expect(json(bad).error.code).toBe(-32600)

    const ok = await rpc({ ...bearer(kevin), 'mcp-protocol-version': '2025-11-25' }, 'ping')
    expect(ok.statusCode).toBe(200)
    expect((await rpc(bearer(kevin), 'ping')).statusCode).toBe(200)
  })

  it('403s a foreign Origin; same-origin and no Origin pass', async () => {
    const host = { host: 'waffled.example:8080' }
    const foreign = await rpc({ ...bearer(kevin), ...host, origin: 'https://evil.example' }, 'ping')
    expect(foreign.statusCode).toBe(403)

    const same = await rpc({ ...bearer(kevin), ...host, origin: 'http://waffled.example:8080' }, 'ping')
    expect(same.statusCode).toBe(200)

    const proxied = await rpc(
      { ...bearer(kevin), host: 'api:3000', 'x-forwarded-host': 'home.example', 'x-forwarded-proto': 'https', origin: 'https://home.example' },
      'ping'
    )
    expect(proxied.statusCode).toBe(200)

    expect((await rpc({ ...bearer(kevin), ...host }, 'ping')).statusCode).toBe(200)
  })
})

describe('tools with a user session (full rights)', () => {
  it('lists whoami with its schema', async () => {
    const body = json(await rpc(bearer(kevin), 'tools/list'))
    const whoami = body.result.tools.find((t: { name: string }) => t.name === 'whoami')
    expect(whoami).toBeDefined()
    expect(whoami.inputSchema.type).toBe('object')
    expect(typeof whoami.description).toBe('string')
    expect(whoami.annotations).toMatchObject({ readOnlyHint: true })
  })

  it('whoami returns household and caller, nothing more', async () => {
    const body = json(await rpc(bearer(kevin), 'tools/call', { name: 'whoami', arguments: {} }))
    expect(body.result.isError).toBeFalsy()
    expect(body.result.structuredContent).toEqual({
      household: { id: householdId, name: 'Sites' },
      person: { id: ownerId, name: 'Kevin', memberType: 'adult', isAdmin: true },
    })
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
  })

  it('an unknown tool is -32602', async () => {
    const body = json(await rpc(bearer(kevin), 'tools/call', { name: 'nope', arguments: {} }))
    expect(body.error.code).toBe(-32602)
  })

  it('bad arguments are a tool result with isError, not a JSON-RPC error', async () => {
    const body = json(await rpc(bearer(kevin), 'tools/call', { name: 'whoami', arguments: 'x' }))
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
  })
})

describe('tools with an API key (per-tool scope is the gate)', () => {
  let familyKey = ''
  let listsKey = ''

  beforeAll(async () => {
    familyKey = await mintKey('mcp-family', ['family:read'])
    listsKey = await mintKey('mcp-lists', ['lists:read'])
  })

  it('a key holding family:read lists and calls whoami (x-api-key and Bearer)', async () => {
    const listed = json(await rpc(keyed(familyKey), 'tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(listed).toContain('whoami')

    for (const h of [keyed(familyKey), bearer(familyKey)]) {
      const res = await rpc(h, 'tools/call', { name: 'whoami', arguments: {} })
      expect(res.statusCode).toBe(200)
      expect(json(res).result.structuredContent.person.id).toBe(ownerId)
    }
  })

  it('a key without the scope does not see the tool and is refused when it calls it', async () => {
    const listed = json(await rpc(keyed(listsKey), 'tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(listed).not.toContain('whoami')

    const body = json(await rpc(keyed(listsKey), 'tools/call', { name: 'whoami', arguments: {} }))
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/missing the required scope: family:read/)
    expect(body.result.structuredContent).toBeUndefined()
  })

  it('an unknown key is 401', async () => {
    expect((await rpc(keyed('waffled_not_a_real_key'), 'ping')).statusCode).toBe(401)
    expect((await rpc(bearer('waffled_not_a_real_key'), 'ping')).statusCode).toBe(401)
  })

  // No route lives under /mcp yet (lambda-api rejects unrouted paths before the gate), so
  // drive the gate function directly for the paths a future route could add.
  it('the carve-out is /mcp exactly — anything under or beside it stays fail-closed for keys', async () => {
    const { enforceApiKeyScope } = await import('../src/modules/api-keys/api-keys')
    const asKey = (path: string) => ({ method: 'POST', path, apiKey: { id: 'k', scopes: ['family:read'] } }) as never
    expect(() => enforceApiKeyScope(asKey('/mcp'))).not.toThrow()
    for (const path of ['/mcp/', '/mcp/anything', '/mcpx', '/api/mcp']) {
      expect(() => enforceApiKeyScope(asKey(path)), path).toThrow('This endpoint is not available to API keys')
    }
  })

  it('the carve-out does not loosen REST: the same key is still scope-checked off /mcp', async () => {
    expect((await run('GET', '/api/lists', keyed(familyKey))).statusCode).toBe(403)
    expect((await run('GET', '/api/permissions', keyed(familyKey))).statusCode).toBe(403)
  })

  it('a Bearer waffled_ key is only treated as a key on /mcp', async () => {
    expect((await run('GET', '/api/household', bearer(familyKey))).statusCode).toBe(401)
  })
})

describe('module gate', () => {
  it('hides and refuses a tool whose module the household turned off', async () => {
    const { defineTool, toolRegistry } = await import('../src/modules/mcp/registry')
    const before = toolRegistry().length
    defineTool({
      name: 'test_pantry_probe',
      description: 'test-only',
      scope: 'pantry:read',
      module: 'pantry',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ data: { ok: true }, summary: 'ok' }),
    })
    try {
      // pantry is off by default
      const listed = json(await rpc(bearer(kevin), 'tools/list')).result.tools.map((t: { name: string }) => t.name)
      expect(listed).not.toContain('test_pantry_probe')
      const off = json(await rpc(bearer(kevin), 'tools/call', { name: 'test_pantry_probe', arguments: {} }))
      expect(off.result.isError).toBe(true)
      expect(off.result.content[0].text).toMatch(/pantry module is not enabled/)

      const { query } = await import('../src/platform/db')
      await query(
        `update households set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}', coalesce(settings->'modules', '{}'::jsonb) || '{"pantry": true}'::jsonb) where id = $1`,
        [householdId]
      )
      const on = json(await rpc(bearer(kevin), 'tools/call', { name: 'test_pantry_probe', arguments: {} }))
      expect(on.result.structuredContent).toEqual({ ok: true })
    } finally {
      const { unregisterToolForTest } = await import('../src/modules/mcp/registry')
      unregisterToolForTest('test_pantry_probe')
      expect(toolRegistry().length).toBe(before)
    }
  })
})

// Fail-closed, like the route-table test in api-keys.integration.test.ts: a tool must
// declare a real scope string from the catalog, or nothing can authorize it.
describe('tool registry guard', () => {
  it('every tool declares a scope that exists in API_SCOPES', async () => {
    const { toolRegistry } = await import('../src/modules/mcp/registry')
    const { ALL_SCOPES } = await import('../src/modules/api-keys/api-keys')
    const tools = toolRegistry()
    expect(tools.length).toBeGreaterThan(0)
    const bad = tools
      .filter((t) => typeof t.scope !== 'string' || !ALL_SCOPES.includes(t.scope))
      .map((t) => `${t.name}: scope=${JSON.stringify(t.scope)}`)
    expect(bad.join('\n')).toBe('')
  })

  it('tool names are unique', async () => {
    const { toolRegistry } = await import('../src/modules/mcp/registry')
    const names = toolRegistry().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
