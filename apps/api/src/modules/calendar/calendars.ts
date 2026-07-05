// Calendar — Google connect (roadmap 5.2). Links a Google account to the household
// and imports its calendars, each mappable to a Waffled person for color/ownership.
//
// The OAuth round-trip:
//   1. POST /api/calendar/google/connect  (authed) → mints a one-time state row and
//      returns the Google consent URL.
//   2. Google redirects the browser to GET /auth/google/calendar/callback (PUBLIC —
//      no Authorization header), which consumes the state, exchanges the code, stores
//      the encrypted refresh token, and imports the calendar list.
//   3. GET /api/calendar/google/status lists what's connected; PATCH maps a calendar
//      to a person / toggles sync; DELETE disconnects an account.
//
// Inbound/outbound event sync (5.3/5.4) build on the rows created here. This flow is
// fully independent of Auth0 — it only needs the logged-in caller's household.
import createAPI, { type Request, type Response } from 'lambda-api'
import { randomBytes } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { adminRoute } from '../../platform/route-guards'
import { encryptSecret, encryptionAvailable } from '../../platform/crypto'
import {
  googleConfigured,
  buildAuthUrl,
  exchangeCode,
  fetchUserinfo,
  listCalendars,
  type GoogleTokens,
  type GoogleUserinfo,
  type GoogleCalendarListEntry,
} from '../../integrations/google'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_TTL_MIN = 15

interface AccountRow extends QueryResultRow {
  id: string
  email: string | null
  google_sub: string
  scope: string | null
  created_at: Date
  updated_at: Date
  last_sync_error: string | null
  last_sync_error_at: Date | null
}

interface CalendarRow extends QueryResultRow {
  id: string
  account_id: string
  person_id: string | null
  person_name?: string | null
  person_color?: string | null
  google_calendar_id: string
  summary: string | null
  timezone: string | null
  access_role: string | null
  color_hex: string | null
  is_primary: boolean
  selected: boolean
  is_write_target: boolean
  last_synced_at: Date | null
}

// ── Persistence ──────────────────────────────────────────────────────────────

// Upsert the account + its calendars in one transaction. Re-connecting refreshes
// the token and calendar metadata but PRESERVES any person mapping / selected flag
// the household has already chosen (those are waffled-owned, not Google-owned).
async function storeConnection(opts: {
  householdId: string
  personId: string
  tokens: GoogleTokens
  info: GoogleUserinfo
  calendars: GoogleCalendarListEntry[]
}): Promise<void> {
  const { householdId, personId, tokens, info, calendars } = opts
  if (!tokens.refreshToken) {
    throw new Error('Google did not return a refresh token (revoke access and reconnect)')
  }
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const acc = await client.query<{ id: string }>(
      `insert into calendar_accounts
         (household_id, person_id, google_sub, email, scope, refresh_token_encrypted)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (household_id, google_sub) do update set
         email = excluded.email,
         scope = excluded.scope,
         refresh_token_encrypted = excluded.refresh_token_encrypted,
         person_id = coalesce(calendar_accounts.person_id, excluded.person_id),
         last_sync_error = null,
         last_sync_error_at = null,
         deleted_at = null
       returning id`,
      [householdId, personId, info.sub, info.email, tokens.scope, encryptSecret(tokens.refreshToken)]
    )
    const accountId = acc.rows[0].id

    for (const c of calendars) {
      await client.query(
        `insert into calendars
           (household_id, account_id, person_id, google_calendar_id, summary, description,
            timezone, access_role, color_hex, is_primary)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (account_id, google_calendar_id) do update set
           summary = excluded.summary,
           description = excluded.description,
           timezone = excluded.timezone,
           access_role = excluded.access_role,
           color_hex = excluded.color_hex,
           is_primary = excluded.is_primary,
           deleted_at = null`,
        [
          householdId,
          accountId,
          c.primary ? personId : null, // seed primary → connector; others unmapped
          c.id,
          c.summary,
          c.description,
          c.timeZone,
          c.accessRole,
          c.backgroundColor,
          c.primary,
        ]
      )
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

async function listAccounts(householdId: string): Promise<AccountRow[]> {
  const { rows } = await query<AccountRow>(
    `select id, email, google_sub, scope, created_at, updated_at, last_sync_error, last_sync_error_at
       from calendar_accounts
      where household_id = $1 and deleted_at is null
      order by created_at`,
    [householdId]
  )
  return rows
}

async function listHouseholdCalendars(householdId: string): Promise<CalendarRow[]> {
  const { rows } = await query<CalendarRow>(
    `select c.id, c.account_id, c.person_id, c.google_calendar_id, c.summary, c.timezone,
            c.access_role, c.color_hex, c.is_primary, c.selected, c.is_write_target, c.last_synced_at,
            p.name as person_name, p.color_hex as person_color
       from calendars c
       left join persons p on p.id = c.person_id and p.deleted_at is null
      where c.household_id = $1 and c.deleted_at is null
      order by c.is_primary desc, c.summary`,
    [householdId]
  )
  return rows
}

// ── Presenters ───────────────────────────────────────────────────────────────

function presentAccount(a: AccountRow) {
  return {
    id: a.id,
    email: a.email,
    googleSub: a.google_sub,
    scope: a.scope,
    connectedAt: a.created_at,
    lastSyncError: a.last_sync_error ?? null,
    lastSyncErrorAt: a.last_sync_error_at ?? null,
  }
}

function presentCalendar(c: CalendarRow) {
  return {
    id: c.id,
    accountId: c.account_id,
    googleCalendarId: c.google_calendar_id,
    summary: c.summary,
    timezone: c.timezone,
    accessRole: c.access_role,
    colorHex: c.color_hex,
    isPrimary: c.is_primary,
    selected: c.selected,
    isWriteTarget: c.is_write_target,
    personId: c.person_id,
    personName: c.person_name ?? null,
    personColor: c.person_color ?? null,
    lastSyncedAt: c.last_synced_at ?? null,
  }
}

// Minimal self-contained page shown when the OAuth dance ends without a redirect
// target (e.g. the kiosk popped a tab just for the grant).
function resultPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#faf7f2;color:#2b2b2b;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border-radius:16px;padding:2.5rem 3rem;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center;max-width:28rem}
h1{margin:0 0 .5rem;font-size:1.25rem}p{margin:0;color:#666}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function registerCalendarRoutes(api: Api): void {
  // Start the connect flow → returns the Google consent URL for the client to open.
  api.post('/api/calendar/google/connect', adminRoute(async (tenant, req: Request, res: Response) => {
    if (!googleConfigured()) {
      return res.status(501).json({
        error: 'NotConfigured',
        message:
          'Google OAuth is not configured on the server (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALENDAR_REDIRECT_URI)',
      })
    }
    if (!encryptionAvailable()) {
      return res.status(501).json({
        error: 'NotConfigured',
        message: 'TOKEN_ENCRYPTION_KEY is not set; refresh tokens cannot be stored encrypted',
      })
    }
    const redirectTo =
      typeof (req.body as { redirectTo?: unknown })?.redirectTo === 'string'
        ? (req.body as { redirectTo: string }).redirectTo
        : null
    const state = randomBytes(24).toString('base64url')
    await query(
      `insert into calendar_oauth_states (state, household_id, person_id, redirect_to)
       values ($1,$2,$3,$4)`,
      [state, tenant.householdId, tenant.personId, redirectTo]
    )
    return { url: buildAuthUrl(state) }
  }))

  // PUBLIC — Google redirects the browser here after consent. No auth header; the
  // one-time state resolves the household. Renders an HTML result (or redirects).
  api.get('/auth/google/calendar/callback', async (req: Request, res: Response) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>
    if (q.error) {
      return res.status(400).html(resultPage('Connection cancelled', `Google returned: ${q.error}`))
    }
    const code = typeof q.code === 'string' ? q.code : ''
    const state = typeof q.state === 'string' ? q.state : ''
    if (!code || !state) {
      return res.status(400).html(resultPage('Connection failed', 'Missing authorization code or state.'))
    }

    // Consume the state (one-time) and drop any other expired states while here.
    const { rows } = await query<{ household_id: string; person_id: string | null; redirect_to: string | null }>(
      `delete from calendar_oauth_states
        where state = $1 and created_at > now() - interval '${STATE_TTL_MIN} minutes'
        returning household_id, person_id, redirect_to`,
      [state]
    )
    await query(`delete from calendar_oauth_states where created_at <= now() - interval '${STATE_TTL_MIN} minutes'`)
    const st = rows[0]
    if (!st) {
      return res
        .status(400)
        .html(resultPage('Link expired', 'This connection link has expired. Please try connecting again.'))
    }

    try {
      const tokens = await exchangeCode(code)
      const info = await fetchUserinfo(tokens.accessToken)
      const calendars = await listCalendars(tokens.accessToken)
      await storeConnection({
        householdId: st.household_id,
        personId: st.person_id ?? '',
        tokens,
        info,
        calendars,
      })
    } catch (err) {
      console.error('calendar callback failed', err)
      return res
        .status(502)
        .html(resultPage('Connection failed', 'Could not complete the Google connection. Please try again.'))
    }

    if (st.redirect_to) return res.redirect(st.redirect_to)
    return res.html(resultPage('Calendar connected', 'You can close this tab and return to Waffled.'))
  })

  // What's connected: accounts + their calendars (with person mapping).
  api.get('/api/calendar/google/status', adminRoute(async (tenant) => {
    const [accounts, calendars] = await Promise.all([
      listAccounts(tenant.householdId),
      listHouseholdCalendars(tenant.householdId),
    ])
    return {
      configured: googleConfigured(),
      connected: accounts.length > 0,
      accounts: accounts.map(presentAccount),
      calendars: calendars.map(presentCalendar),
    }
  }))

  // Map a calendar to a person / toggle whether Waffled syncs it (admins).
  api.patch('/api/calendar/google/calendars/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'calendar not found' })
    const body = (req.body ?? {}) as { personId?: string | null; selected?: boolean; isWriteTarget?: boolean }

    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    if ('personId' in body) {
      sets.push(`person_id = $${i++}`)
      values.push(body.personId ?? null)
    }
    if ('selected' in body) {
      sets.push(`selected = $${i++}`)
      values.push(!!body.selected)
    }
    if ('isWriteTarget' in body) {
      sets.push(`is_write_target = $${i++}`)
      values.push(!!body.isWriteTarget)
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'personId, selected, or isWriteTarget required' })
    }
    values.push(tenant.householdId, id)
    const { rowCount } = await query(
      `update calendars set ${sets.join(', ')}
        where household_id = $${i++} and id = $${i} and deleted_at is null`,
      values
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'calendar not found' })
    // Only one write target per person: clear the flag on this calendar's siblings.
    // (Runs after the update so it uses the calendar's final person.)
    if (body.isWriteTarget === true) {
      await query(
        `update calendars set is_write_target = false
          where household_id = $1 and id <> $2 and deleted_at is null
            and person_id = (select person_id from calendars where id = $2)`,
        [tenant.householdId, id]
      )
    }
    const calendars = await listHouseholdCalendars(tenant.householdId)
    const updated = calendars.find((c) => c.id === id)
    return { calendar: updated ? presentCalendar(updated) : null }
  }))

  // Disconnect an account: soft-delete it and its calendars (events are kept).
  api.delete('/api/calendar/google/accounts/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'account not found' })
    const { rowCount } = await query(
      `update calendar_accounts set deleted_at = now()
        where id = $1 and household_id = $2 and deleted_at is null`,
      [id, tenant.householdId]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'account not found' })
    await query(
      `update calendars set deleted_at = now()
        where account_id = $1 and household_id = $2 and deleted_at is null`,
      [id, tenant.householdId]
    )
    return res.status(204).send('')
  }))
}
