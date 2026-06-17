// Calendar Google-sync — shared result + write-target types.

export interface CalendarSyncResult {
  calendarId: string
  summary: string | null
  imported: number
  updated: number
  deleted: number
  fullResync: boolean
  error?: string
}

export interface HouseholdSyncResult {
  calendars: CalendarSyncResult[]
  imported: number
  updated: number
  deleted: number
}

export interface WriteTarget {
  calendarId: string
  googleCalendarId: string
  refreshTokenEncrypted: string
}

export interface PushPendingResult {
  created: number
  updated: number
  deleted: number
  failed: number
}
