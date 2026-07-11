// Weekly-digest scheduler. Mirrors chore-proof-cleanup.service.ts: a setInterval tick
// wrapped in runJob, started from server.ts. Container-only — Lambda never runs
// server.ts (a Lambda deployment would drive sendDueDigests from EventBridge instead).
//
// setInterval is not cron, so we don't trust tick timing: each tick asks, per
// household, "is it the configured weekday at/after the configured local hour, and
// haven't we already sent this ISO week?" — the per-week claim (claimWeeklyDigest)
// makes delivery at-most-once even across many ticks in the send hour or a restart.
import { DateTime } from 'luxon'
import { query } from '../../platform/db'
import { runJob, registerJob } from '../../platform/jobs'
import { log } from '../../platform/logger'
import { config } from '../../platform/config'
import { sendMail } from '../../platform/email'
import { getSmtpSettings, claimWeeklyDigest, markWeeklyDigestFailed } from './email-settings.service'
import { buildWeeklyDigest } from './digest.service'

interface DueRow {
  household_id: string
  timezone: string
  digest_dow: number
  digest_hour: number
  digest_sections: unknown
}

// Stable per-household, per-ISO-week dedupe key (e.g. 'weekly_digest:2026-W28').
export function isoWeekKey(dt: DateTime): string {
  return `weekly_digest:${dt.weekYear}-W${String(dt.weekNumber).padStart(2, '0')}`
}

// Due on the configured weekday (ISO 1=Mon…7=Sun) at/after the configured local hour.
export function isDigestDue(nowLocal: DateTime, dow: number, hour: number): boolean {
  return nowLocal.weekday === dow && nowLocal.hour >= hour
}

// Distinct adult account emails for a household.
async function digestRecipients(householdId: string): Promise<string[]> {
  const { rows } = await query<{ email: string }>(
    `select distinct a.email from persons p
       join accounts a on a.id = p.account_id and a.deleted_at is null and a.email is not null
      where p.household_id = $1 and p.deleted_at is null and p.member_type = 'adult'`,
    [householdId]
  )
  return rows.map((r) => r.email).filter(Boolean)
}

// One sweep: send any due digests. `nowUtc` is injectable so tests can pin the clock.
export async function sendDueDigests(nowUtc?: DateTime): Promise<{ sent: number; considered: number }> {
  const { rows } = await query<DueRow>(
    `select h.id as household_id, h.timezone, s.digest_dow, s.digest_hour, s.digest_sections
       from household_email_settings s
       join households h on h.id = s.household_id and h.deleted_at is null
      where s.enabled = true and s.digest_enabled = true`
  )
  let sent = 0
  for (const r of rows) {
    const tz = r.timezone || 'UTC'
    const now = (nowUtc ?? DateTime.utc()).setZone(tz)
    if (!isDigestDue(now, r.digest_dow, r.digest_hour)) continue

    const smtp = await getSmtpSettings(r.household_id)
    if (!smtp) continue

    const weekStart = now.toISODate()!
    const sections = Array.isArray(r.digest_sections) ? (r.digest_sections as string[]) : undefined
    let digest: { subject: string; html: string; text: string }
    try {
      digest = await buildWeeklyDigest(r.household_id, weekStart, sections)
    } catch (e) {
      log.error('weekly digest build failed', { household: r.household_id, err: e })
      continue
    }

    const dedupeKey = isoWeekKey(now)
    // Claim first — if another tick already claimed this week, skip silently.
    if (!(await claimWeeklyDigest(r.household_id, dedupeKey, digest.subject))) continue

    const recipients = await digestRecipients(r.household_id)
    if (!recipients.length) continue
    try {
      for (const to of recipients) {
        await sendMail(smtp, { to, subject: digest.subject, html: digest.html, text: digest.text })
      }
      sent++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await markWeeklyDigestFailed(r.household_id, dedupeKey, msg)
      log.error('weekly digest send failed', { household: r.household_id, err: msg })
    }
  }
  return { sent, considered: rows.length }
}

let digestTimer: ReturnType<typeof setInterval> | null = null

export function startWeeklyDigestScheduler(): void {
  if (digestTimer) return
  const intervalMs = config.email.weeklyDigestIntervalMs
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  registerJob('weekly-digest')
  digestTimer = setInterval(() => {
    runJob('weekly-digest', () => sendDueDigests()).catch((err) =>
      log.error('weekly digest tick failed', { err })
    )
  }, intervalMs)
  digestTimer.unref?.()
  log.info('weekly digest scheduler started', { intervalSec: Math.round(intervalMs / 1000) })
}
