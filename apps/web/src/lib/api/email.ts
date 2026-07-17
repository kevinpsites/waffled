// Outbound-email (SMTP) admin settings — client slice for the Notifications tab.
// Mirrors Immich's "Notification Settings": read/write the SMTP transport + digest
// prefs, plus a "send test email and save" action. All routes are admin-gated.
import { apiGet, apiSend } from './client'

export const DIGEST_SECTIONS = ['calendar', 'meals', 'grocery', 'chores'] as const
export type DigestSection = (typeof DIGEST_SECTIONS)[number]

// What the server returns — note there is NO password field, only `hasPassword`.
export interface EmailSettings {
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
  digestDow: number // ISO day-of-week: 1 = Mon … 7 = Sun
  digestHour: number // 0–23, household-local
  digestSections: string[]
  // TOKEN_ENCRYPTION_KEY present — when false the UI can't save a password at rest.
  canEncrypt: boolean
}

// A partial patch. Omitting `password` preserves the stored one — only send it when
// the user actually typed a new value.
export interface EmailSettingsPatch {
  enabled?: boolean
  host?: string | null
  port?: number
  secure?: boolean
  ignoreCert?: boolean
  username?: string | null
  password?: string
  fromName?: string | null
  fromAddress?: string | null
  digestEnabled?: boolean
  digestDow?: number
  digestHour?: number
  digestSections?: string[]
}

export interface EmailTestResult {
  ok: boolean
  sentTo: string
  settings?: EmailSettings
  // Present when the send succeeded but persisting the config didn't (e.g. no key).
  saved?: boolean
  message?: string
}

export const emailApi = {
  getSettings: () => apiGet<EmailSettings>('/api/email/settings'),
  // Returns { settings }. A 400 (ApiSendError) carries the reason in `.body.message`.
  updateSettings: (patch: EmailSettingsPatch) =>
    apiSend<{ settings: EmailSettings }>('PUT', '/api/email/settings', patch),
  // Sends a test to the caller's own login email and, on success, saves. A 400
  // carries the real SMTP error verbatim in `.body.message` — surface it.
  sendTest: (patch: EmailSettingsPatch) =>
    apiSend<EmailTestResult>('POST', '/api/email/settings/test', patch),
}
