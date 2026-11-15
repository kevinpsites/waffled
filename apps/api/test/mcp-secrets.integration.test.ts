// No secrets in tool output (docs/product/mcp-plan.md §5): every read tool runs against a
// household that holds one of each kind of secret, and no result may contain any of them.
// A new read tool fails here until it has an argument fixture, so it can't skip the check.
import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startMcpHarness, bearer, keyed, json, type McpHarness } from './helpers/mcp'
import { localYmd, zonedToUtc } from '../src/modules/capture/tz'

const TZ = 'America/Chicago'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

let h: McpHarness
let kevin = ''
let readKey = ''
let groceryListId = ''
const secrets: Record<string, string> = {}

beforeAll(async () => {
  h = await startMcpHarness()
  kevin = h.owner
  const today = localYmd(new Date(), TZ)
  const kelly = await h.addMember('Kelly', 'adult')
  const wally = await h.addMember('Wally', 'kid')

  // Household content, so every read has rows to return.
  expect((await h.call('POST', '/api/events', kevin, { title: 'Soccer practice', startsAt: zonedToUtc(`${today}T15:00`, TZ) })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/chores', kevin, { title: 'Feed the cat', personId: wally.id })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/lists/grocery/items', kevin, { name: 'Milk' })).statusCode).toBe(201)
  groceryListId = (await h.sql<{ id: string }>(`select id from lists where household_id = $1 and list_type = 'grocery'`, [h.householdId]))[0].id
  expect((await h.call('POST', '/api/meals/plan', kevin, { date: today, mealType: 'dinner', title: 'Tacos' })).statusCode).toBe(200)
  expect((await h.call('POST', '/api/recipes', kevin, { title: 'Chicken Tacos' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/goals', kevin, { title: 'Reading minutes', goalType: 'total', unit: 'minutes', targetValue: 600, trackingMode: 'shared_total' })).statusCode).toBe(201)
  expect((await h.call('POST', '/api/rewards', kevin, { title: 'Ice cream night', cost: 5, requiresApproval: false })).statusCode).toBe(201)
  expect((await h.call('POST', `/api/persons/${wally.id}/award`, kevin, { amount: 10 })).statusCode).toBe(201)

  // A sign-in for another member: an account email and a password hash.
  secrets.kellyEmail = 'kelly.private@example.com'
  expect((await h.call('PUT', `/api/persons/${kelly.id}/login`, kevin, { email: secrets.kellyEmail, password: 'kellypass12' })).statusCode).toBe(200)
  // Real logins leave rotating refresh tokens behind.
  for (const [email, password] of [['kevin@example.com', 'ownerpass1'], [secrets.kellyEmail, 'kellypass12']]) {
    const login = await h.run('POST', '/api/auth/login', {}, { email, password })
    expect(login.statusCode, login.body).toBe(200)
    secrets[`refresh:${email}`] = json(login).refreshToken
  }

  readKey = await h.mintKey(kevin, 'secrets-read', ['family:read', 'calendar:read', 'chores:read', 'lists:read', 'meals:read', 'goals:read', 'rewards:read'])
  secrets.apiKey = readKey

  // A connector grant with a refresh token.
  const [grant] = await h.sql<{ id: string }>(
    `insert into oauth_grants (household_id, person_id, client_id, client_name, redirect_uri, resource, scopes)
     values ($1, $2, 'https://client.example/meta.json', 'Claude', 'https://claude.ai/api/mcp/auth_callback', 'http://localhost/mcp', '{family:read}')
     returning id`,
    [h.householdId, kelly.id]
  )
  secrets.oauthRefresh = 'oauth-refresh-raw-5be1d7c0a9'
  await h.sql(`insert into oauth_refresh_tokens (grant_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`, [grant.id, sha256(secrets.oauthRefresh)])

  secrets.inviteEmail = 'invitee.private@example.com'
  await h.sql(`insert into household_invites (household_id, email, invited_by) values ($1, $2, $3)`, [h.householdId, secrets.inviteEmail, h.ownerId])
  secrets.pairingCode = 'PAIRCODE7731'
  await h.sql(`insert into kiosk_pairing_codes (code, household_id, created_by) values ($1, $2, $3)`, [secrets.pairingCode, h.householdId, h.ownerId])
  secrets.oidcClientId = 'oidc-client-id-71f2'
  secrets.oidcSecret = 'oidc-secret-enc-4c9a'
  await h.sql(`update auth_config set issuer_url = 'https://sso.example', client_id = $1, client_secret_enc = $2`, [secrets.oidcClientId, secrets.oidcSecret])
  secrets.calendarEmail = 'kelly.calendar@example.com'
  secrets.calendarToken = 'calendar-refresh-enc-88d1'
  await h.sql(
    `insert into calendar_accounts (household_id, person_id, google_sub, email, refresh_token_encrypted, access_token_encrypted)
     values ($1, $2, 'google-sub-1', $3, $4, 'calendar-access-enc-21aa')`,
    [h.householdId, kelly.id, secrets.calendarEmail, secrets.calendarToken]
  )
  secrets.calendarAccess = 'calendar-access-enc-21aa'
  secrets.icsUrl = 'https://calendar.example/feeds/private-token-9f3k.ics'
  await h.sql(`insert into ics_feeds (household_id, url, name) values ($1, $2, 'School')`, [h.householdId, secrets.icsUrl])
  secrets.pinHash = 'pinhash-wally-3e7d'
  await h.sql(`update persons set pin_hash = $1 where id = $2`, [secrets.pinHash, wally.id])

  // Every stored hash and the key's display prefix, read back from the database.
  const hashes = await h.sql<{ v: string }>(
    `select token_hash as v from refresh_tokens
     union all select token_hash from oauth_refresh_tokens
     union all select key_hash from api_keys
     union all select key_prefix from api_keys
     union all select password_hash from accounts where password_hash is not null
     union all select email from accounts`
  )
  hashes.forEach((r, i) => (secrets[`stored:${i}`] = r.v))
  expect(hashes.length).toBeGreaterThan(6)
})

afterAll(async () => {
  await h?.close()
})

function readArgs(today: string): Record<string, Record<string, unknown>> {
  return {
    whoami: {},
    list_family: {},
    get_today: {},
    list_events: { from: addDays(today, -1), to: addDays(today, 7) },
    list_chores: {},
    get_grocery_list: {},
    list_lists: { listId: groceryListId },
    get_meal_plan: {},
    search_recipes: { query: 'tacos' },
    list_goals: {},
    get_reward_balances: {},
    find_chores: { description: 'feed the cat' },
    find_list_items: { description: 'milk' },
    find_events: { description: 'soccer' },
    find_goals: { description: 'reading' },
    find_rewards: { description: 'ice cream' },
    whats_new: { since: new Date(Date.now() - 86_400_000).toISOString() },
  }
}

const FORBIDDEN_KEYS = /"(password_hash|passwordHash|token_hash|tokenHash|key_hash|keyHash|pin_hash|pinHash|client_secret\w*|clientSecret\w*|refresh_token\w*|refreshToken\w*|email)"\s*:/

describe('no secrets in tool output', () => {
  it('every read tool has an argument fixture here', async () => {
    const { toolRegistry, isWriteTool } = await import('../src/modules/mcp/registry')
    const fixtures = readArgs('2026-01-01')
    const missing = toolRegistry()
      .filter((t) => !isWriteTool(t) && !t.name.startsWith('test_'))
      .map((t) => t.name)
      .filter((n) => !(n in fixtures))
    expect(missing).toEqual([])
  })

  for (const [label, headers] of [
    ['a user session', () => bearer(kevin)],
    ['an API key', () => keyed(readKey)],
  ] as const) {
    it(`no read tool returns a token, key, hash, code, OIDC secret or account email (${label})`, async () => {
      const { toolRegistry, isWriteTool } = await import('../src/modules/mcp/registry')
      const fixtures = readArgs(localYmd(new Date(), TZ))
      const leaks: string[] = []
      for (const tool of toolRegistry().filter((t) => !isWriteTool(t) && !t.name.startsWith('test_'))) {
        const res = await h.tool(headers(), tool.name, fixtures[tool.name])
        expect(res.isError, `${tool.name}: ${JSON.stringify(res.content)}`).toBeFalsy()
        const out = JSON.stringify(res)
        for (const [name, value] of Object.entries(secrets)) {
          if (value && out.toLowerCase().includes(value.toLowerCase())) leaks.push(`${tool.name} leaks ${name}`)
        }
        const key = out.match(FORBIDDEN_KEYS)
        if (key) leaks.push(`${tool.name} returns a ${key[1]} field`)
        if (/\$2[aby]\$|\$argon2|\$scrypt/.test(out)) leaks.push(`${tool.name} returns a password-hash-shaped value`)
      }
      expect(leaks).toEqual([])
    })
  }
})
