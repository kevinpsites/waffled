// Per-household outbound-email settings. Transport config + the encrypted App
// Password live in household_email_settings; this module is the only place that
// reads/writes it. Two shapes leave here:
//   - EmailSettingsView  — safe for clients (NO password, just hasPassword)
//   - SmtpSettings        — internal, password DECRYPTED, for the send path only
import { query } from '../../platform/db'
import { encryptSecret, decryptSecret, encryptionAvailable } from '../../platform/crypto'
import type { SmtpSettings } from '../../platform/email'

export const DIGEST_SECTIONS = ['calendar', 'meals', 'grocery', 'chores'] as const
export type DigestSection = (typeof DIGEST_SECTIONS)[number]

// Sensible defaults for a household that has never configured email.
const DEFAULTS = {
  enabled: false,
  host: null as string | null,
  port: 587,
  secure: false,
  ignoreCert: false,
  username: null as string | null,
  fromName: null as string | null,
  fromAddress: null as string | null,
  digestEnabled: false,
  digestDow: 1,
  digestHour: 7,
  digestSections: [...DIGEST_SECTIONS] as string[],
}

export interface EmailSettingsView {
  enabled: boolean
  host: string | null
  port: number
  secure: boolean
  ignoreCert: boolean
  username: string | null
  hasPassword: boolean
  fromName: string | null
  fromAddress: string | null
  digestEnabled: boolean
  digestDow: number
  digestHour: number
  digestSections: string[]
  /** Whether TOKEN_ENCRYPTION_KEY is present — the UI disables the password field
   *  (and saving a password) when we can't encrypt it at rest. */
  canEncrypt: boolean
}

// A partial patch from the UI. `password` semantics: omitted (undefined) => keep the
// stored one; empty string/null => clear it; non-empty => encrypt + store.
export interface EmailSettingsInput {
  enabled?: boolean
  host?: string | null
  port?: number
  secure?: boolean
  ignoreCert?: boolean
  username?: string | null
  password?: string | null
  fromName?: string | null
  fromAddress?: string | null
  digestEnabled?: boolean
  digestDow?: number
  digestHour?: number
  digestSections?: string[]
}

interface Row {
  enabled: boolean
  host: string | null
  port: number
  secure: boolean
  ignore_cert: boolean
  username: string | null
  password_enc: string | null
  from_name: string | null
  from_address: string | null
  digest_enabled: boolean
  digest_dow: number
  digest_hour: number
  digest_sections: unknown
}

async function fetchRow(householdId: string): Promise<Row | null> {
  const { rows } = await query<Row>(
    `select enabled, host, port, secure, ignore_cert, username, password_enc,
            from_name, from_address, digest_enabled, digest_dow, digest_hour, digest_sections
       from household_email_settings where household_id = $1`,
    [householdId]
  )
  return rows[0] ?? null
}

function sectionsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DIGEST_SECTIONS]
  const set = new Set(DIGEST_SECTIONS as readonly string[])
  const cleaned = raw.filter((s): s is string => typeof s === 'string' && set.has(s))
  return cleaned.length ? cleaned : [...DIGEST_SECTIONS]
}

// Client-safe view. Never includes the password — only whether one is stored.
export async function getEmailSettings(householdId: string): Promise<EmailSettingsView> {
  const row = await fetchRow(householdId)
  const base = row
    ? {
        enabled: row.enabled,
        host: row.host,
        port: row.port,
        secure: row.secure,
        ignoreCert: row.ignore_cert,
        username: row.username,
        hasPassword: !!row.password_enc,
        fromName: row.from_name,
        fromAddress: row.from_address,
        digestEnabled: row.digest_enabled,
        digestDow: row.digest_dow,
        digestHour: row.digest_hour,
        digestSections: sectionsOf(row.digest_sections),
      }
    : { ...DEFAULTS, hasPassword: false }
  return { ...base, canEncrypt: encryptionAvailable() }
}

// Internal: the decrypted transport settings for the send path. Returns null when
// the household has no usable transport (disabled, or missing host/username/password).
export async function getSmtpSettings(householdId: string): Promise<SmtpSettings | null> {
  const row = await fetchRow(householdId)
  if (!row || !row.enabled || !row.host) return null
  let password: string | null = null
  if (row.password_enc) {
    try {
      password = decryptSecret(row.password_enc)
    } catch {
      return null // key rotated away / corrupt — treat as unconfigured, don't throw on the hot path
    }
  }
  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    ignoreCert: row.ignore_cert,
    username: row.username,
    password,
    fromName: row.from_name,
    fromAddress: row.from_address,
  }
}

// The decrypted stored password, or null. Used by the "send test" route so an admin
// can re-test without re-typing an already-saved App Password.
export async function getStoredPassword(householdId: string): Promise<string | null> {
  const row = await fetchRow(householdId)
  if (!row?.password_enc) return null
  try {
    return decryptSecret(row.password_enc)
  } catch {
    return null
  }
}

const clampInt = (v: number, lo: number, hi: number, dflt: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt

// Read-merge-write upsert. Settings writes are rare and low-concurrency, so merging
// in JS is simpler and safer than a big COALESCE upsert — and it makes the
// preserve-password-on-omit rule trivial.
export async function upsertEmailSettings(
  householdId: string,
  input: EmailSettingsInput
): Promise<EmailSettingsView> {
  const row = await fetchRow(householdId)
  const cur = row ?? {
    enabled: DEFAULTS.enabled,
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    secure: DEFAULTS.secure,
    ignore_cert: DEFAULTS.ignoreCert,
    username: DEFAULTS.username,
    password_enc: null,
    from_name: DEFAULTS.fromName,
    from_address: DEFAULTS.fromAddress,
    digest_enabled: DEFAULTS.digestEnabled,
    digest_dow: DEFAULTS.digestDow,
    digest_hour: DEFAULTS.digestHour,
    digest_sections: DEFAULTS.digestSections,
  }

  // Password: undefined => preserve; ''/null => clear; non-empty => encrypt.
  let passwordEnc = cur.password_enc
  if (input.password !== undefined) {
    const p = input.password
    if (p == null || p.trim() === '') {
      passwordEnc = null
    } else {
      if (!encryptionAvailable()) {
        throw new EmailSettingsError('TOKEN_ENCRYPTION_KEY is not set — cannot store an SMTP password')
      }
      passwordEnc = encryptSecret(p)
    }
  }

  const merged = {
    enabled: input.enabled ?? cur.enabled,
    host: input.host !== undefined ? input.host : cur.host,
    port: input.port !== undefined ? clampInt(input.port, 1, 65535, DEFAULTS.port) : cur.port,
    secure: input.secure ?? cur.secure,
    ignore_cert: input.ignoreCert ?? cur.ignore_cert,
    username: input.username !== undefined ? input.username : cur.username,
    password_enc: passwordEnc,
    from_name: input.fromName !== undefined ? input.fromName : cur.from_name,
    from_address: input.fromAddress !== undefined ? input.fromAddress : cur.from_address,
    digest_enabled: input.digestEnabled ?? cur.digest_enabled,
    digest_dow: input.digestDow !== undefined ? clampInt(input.digestDow, 1, 7, DEFAULTS.digestDow) : cur.digest_dow,
    digest_hour: input.digestHour !== undefined ? clampInt(input.digestHour, 0, 23, DEFAULTS.digestHour) : cur.digest_hour,
    digest_sections: input.digestSections !== undefined ? sectionsOf(input.digestSections) : sectionsOf(cur.digest_sections),
  }

  await query(
    `insert into household_email_settings
       (household_id, enabled, host, port, secure, ignore_cert, username, password_enc,
        from_name, from_address, digest_enabled, digest_dow, digest_hour, digest_sections, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, now())
     on conflict (household_id) do update set
       enabled = excluded.enabled, host = excluded.host, port = excluded.port,
       secure = excluded.secure, ignore_cert = excluded.ignore_cert,
       username = excluded.username, password_enc = excluded.password_enc,
       from_name = excluded.from_name, from_address = excluded.from_address,
       digest_enabled = excluded.digest_enabled, digest_dow = excluded.digest_dow,
       digest_hour = excluded.digest_hour, digest_sections = excluded.digest_sections,
       updated_at = now()`,
    [
      householdId,
      merged.enabled,
      merged.host,
      merged.port,
      merged.secure,
      merged.ignore_cert,
      merged.username,
      merged.password_enc,
      merged.from_name,
      merged.from_address,
      merged.digest_enabled,
      merged.digest_dow,
      merged.digest_hour,
      JSON.stringify(merged.digest_sections),
    ]
  )
  return getEmailSettings(householdId)
}

// Record a send attempt (idempotency + audit + test assertions). dedupeKey, when
// set, is guarded by a partial unique index — a duplicate insert throws, which the
// digest scheduler treats as "already sent this week".
export async function recordDelivery(params: {
  householdId: string
  kind: string
  to: string
  subject: string
  dedupeKey?: string | null
  status: 'sent' | 'failed'
  error?: string | null
}): Promise<void> {
  await query(
    `insert into email_deliveries (household_id, kind, to_address, subject, dedupe_key, status, error)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.householdId,
      params.kind,
      params.to,
      params.subject,
      params.dedupeKey ?? null,
      params.status,
      params.error ?? null,
    ]
  )
}

export class EmailSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailSettingsError'
  }
}
