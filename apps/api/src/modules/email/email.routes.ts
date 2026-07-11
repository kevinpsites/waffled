// Outbound-email admin routes. Mirrors Immich's Notification Settings: read/write
// the SMTP transport + digest prefs, plus a "send test email and save" action that
// validates the config against the real server before persisting. All admin-gated.
import createAPI, { type Request, type Response } from 'lambda-api'
import { DateTime } from 'luxon'
import { adminRoute } from '../../platform/route-guards'
import { query } from '../../platform/db'
import { sendMail, type SmtpSettings } from '../../platform/email'
import {
  getEmailSettings,
  upsertEmailSettings,
  getStoredPassword,
  recordDelivery,
  EmailSettingsError,
  type EmailSettingsInput,
} from './email-settings.service'
import { buildWeeklyDigest } from './digest.service'

// The caller's own login email — where a test message goes.
async function callerEmail(personId: string): Promise<string | null> {
  const { rows } = await query<{ email: string | null }>(
    `select a.email from persons p
       left join accounts a on a.id = p.account_id and a.deleted_at is null
      where p.id = $1`,
    [personId]
  )
  return rows[0]?.email ?? null
}

// Pull a typed patch out of the request body (only known keys; unknowns ignored).
function readInput(body: Record<string, unknown>): EmailSettingsInput {
  const input: EmailSettingsInput = {}
  if (typeof body.enabled === 'boolean') input.enabled = body.enabled
  if (body.host !== undefined) input.host = body.host == null ? null : String(body.host).trim() || null
  if (body.port !== undefined) input.port = Number(body.port)
  if (typeof body.secure === 'boolean') input.secure = body.secure
  if (typeof body.ignoreCert === 'boolean') input.ignoreCert = body.ignoreCert
  if (body.username !== undefined) input.username = body.username == null ? null : String(body.username).trim() || null
  if (body.password !== undefined) input.password = body.password == null ? null : String(body.password)
  if (body.fromName !== undefined) input.fromName = body.fromName == null ? null : String(body.fromName).trim() || null
  if (body.fromAddress !== undefined) input.fromAddress = body.fromAddress == null ? null : String(body.fromAddress).trim() || null
  if (typeof body.digestEnabled === 'boolean') input.digestEnabled = body.digestEnabled
  if (body.digestDow !== undefined) input.digestDow = Number(body.digestDow)
  if (body.digestHour !== undefined) input.digestHour = Number(body.digestHour)
  if (Array.isArray(body.digestSections)) input.digestSections = body.digestSections.map(String)
  return input
}

// Reject a config that claims to be enabled but can't actually send.
function validateEnabled(input: EmailSettingsInput, current: { host: string | null; username: string | null }): string | null {
  const willBeEnabled = input.enabled === true
  if (!willBeEnabled) return null
  const host = input.host !== undefined ? input.host : current.host
  const username = input.username !== undefined ? input.username : current.username
  if (!host) return 'host is required when email is enabled'
  if (!username) return 'username is required when email is enabled'
  return null
}

type Api = ReturnType<typeof createAPI>

export function registerEmailRoutes(api: Api): void {
  // Current settings — never includes the password (just hasPassword + canEncrypt).
  api.get('/api/email/settings', adminRoute((tenant) => getEmailSettings(tenant.householdId)))

  // Save transport + digest prefs. Omitting `password` preserves the stored one.
  api.put('/api/email/settings', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const input = readInput(body)
    const cur = await getEmailSettings(tenant.householdId)
    const err = validateEnabled(input, cur)
    if (err) return res.status(400).json({ error: 'BadRequest', message: err })
    try {
      const settings = await upsertEmailSettings(tenant.householdId, input)
      return { settings }
    } catch (e) {
      if (e instanceof EmailSettingsError) return res.status(400).json({ error: 'BadRequest', message: e.message })
      throw e
    }
  }))

  // Send a test email against the SUBMITTED config (so an admin can verify before
  // committing), then persist on success — Immich's "Send test email and save".
  api.post('/api/email/settings/test', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const input = readInput(body)
    const cur = await getEmailSettings(tenant.householdId)

    const to = await callerEmail(tenant.personId)
    if (!to) return res.status(400).json({ error: 'BadRequest', message: 'Your account has no email address to send a test to.' })

    const host = input.host !== undefined ? input.host : cur.host
    const username = input.username !== undefined ? input.username : cur.username
    if (!host) return res.status(400).json({ error: 'BadRequest', message: 'host is required to send a test email' })

    // Use the submitted password, else fall back to the stored one.
    const password = input.password !== undefined && input.password
      ? input.password
      : await getStoredPassword(tenant.householdId)

    const smtp: SmtpSettings = {
      host,
      port: input.port ?? cur.port,
      secure: input.secure ?? cur.secure,
      ignoreCert: input.ignoreCert ?? cur.ignoreCert,
      username,
      password,
      fromName: input.fromName !== undefined ? input.fromName : cur.fromName,
      fromAddress: input.fromAddress !== undefined ? input.fromAddress : cur.fromAddress,
    }

    const subject = 'Waffled test email'
    const html = '<p>This is a test email from <strong>Waffled</strong>. Your SMTP settings are working. 🧇</p>'
    const text = 'This is a test email from Waffled. Your SMTP settings are working.'

    try {
      await sendMail(smtp, { to, subject, html, text })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await recordDelivery({ householdId: tenant.householdId, kind: 'test', to, subject, status: 'failed', error: message })
      // Surface the real SMTP error verbatim — that's what the admin needs to fix it.
      return res.status(400).json({ error: 'SmtpError', message })
    }

    await recordDelivery({ householdId: tenant.householdId, kind: 'test', to, subject, status: 'sent' })
    // Save on success (Immich behavior). Enable if the caller flipped it on. The send
    // already succeeded, so a persist hiccup (e.g. no encryption key for a password)
    // must not 500 — report it without failing the test.
    try {
      const settings = await upsertEmailSettings(tenant.householdId, input)
      return { ok: true, sentTo: to, settings }
    } catch (e) {
      if (e instanceof EmailSettingsError) return { ok: true, sentTo: to, saved: false, message: e.message }
      throw e
    }
  }))

  // Render the current-week digest without sending — drives a UI preview. Uses the
  // household's stored section prefs and today (household-local) as the week start.
  api.post('/api/email/digest/preview', adminRoute(async (tenant) => {
    const { rows } = await query<{ timezone: string }>(
      `select timezone from households where id = $1`,
      [tenant.householdId]
    )
    const tz = rows[0]?.timezone ?? 'UTC'
    const weekStart = DateTime.utc().setZone(tz).toISODate()!
    const cur = await getEmailSettings(tenant.householdId)
    const digest = await buildWeeklyDigest(tenant.householdId, weekStart, cur.digestSections)
    return { subject: digest.subject, html: digest.html, text: digest.text }
  }))
}
