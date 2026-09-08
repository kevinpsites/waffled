import { DateTime, IANAZone } from 'luxon'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export class AccessEndDateError extends Error {}

/**
 * Validate and normalize the household timezone at every application write
 * boundary. PostgreSQL accepts a plain text column here, but the rest of the app
 * requires an IANA zone for calendar-day arithmetic.
 */
export function normalizeHouseholdTimezone(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AccessEndDateError('timezone must be a valid IANA timezone')
  }
  const timezone = value.trim()
  if (!timezone || !IANAZone.isValidZone(timezone)) {
    throw new AccessEndDateError('timezone must be a valid IANA timezone')
  }
  return timezone
}

/**
 * Turn the last household-local day of access into the instant access stops.
 *
 * A calendar date has no offset of its own. Keeping it date-only at the API
 * boundary lets the server apply the household's timezone and store the
 * exclusive start of the following day. Calendar-day arithmetic is deliberate:
 * on a DST boundary this may be 23 or 25 hours after the selected midnight.
 */
export function expiryAfterAccessEndDate(
  value: unknown,
  householdTimezone: string,
  now: Date = new Date()
): Date | null {
  if (value === null) return null
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) {
    throw new AccessEndDateError('accessEndsOn must be null or a YYYY-MM-DD date')
  }
  if (!IANAZone.isValidZone(householdTimezone)) {
    throw new AccessEndDateError('the household timezone is invalid')
  }

  const selectedDay = DateTime.fromISO(value, { zone: householdTimezone })
  if (!selectedDay.isValid || selectedDay.toISODate() !== value) {
    throw new AccessEndDateError('accessEndsOn must be null or a valid YYYY-MM-DD date')
  }

  const expiry = selectedDay.plus({ days: 1 }).startOf('day').toUTC()
  if (!expiry.isValid || expiry.toMillis() <= now.getTime()) {
    throw new AccessEndDateError('accessEndsOn must be today or a future household date')
  }
  return expiry.toJSDate()
}

/**
 * Recover the last complete household day before a legacy exclusive instant.
 *
 * Legacy callers could technically send a non-midnight instant. Rounding an
 * arbitrary daytime value forward would silently extend access, so it floors to
 * the preceding civil date. Shipped clients used a recognizable local
 * 23:59:59(.999) value for the selected final day; preserve that day rather than
 * shortening those memberships by almost 24 hours. Canonical next-midnight values
 * retain their exact meaning too.
 */
export function accessEndDateBeforeExpiry(expiry: string, householdTimezone: string): string {
  if (!IANAZone.isValidZone(householdTimezone)) {
    throw new AccessEndDateError('the household timezone is invalid')
  }
  const instant = DateTime.fromISO(expiry, { setZone: true })
  if (!instant.isValid) throw new AccessEndDateError('accessExpiresAt must be a valid ISO date')
  const local = instant.setZone(householdTimezone)
  const isShippedEndOfDayShape = local.hour === 23 && local.minute === 59 && local.second >= 59
  const date = (isShippedEndOfDayShape ? local : local.minus({ days: 1 })).toISODate()
  if (!date) throw new AccessEndDateError('accessExpiresAt must be a valid ISO date')
  return date
}

export interface CanonicalAccessWindow {
  accessEndsOn: string | null
  // The database derives the paired enforcement instant while holding the same
  // household lock. Passing null prevents a stale caller-computed instant from
  // winning over the canonical civil date.
  accessExpiresAt: null
}

/**
 * Normalize either API representation of a temporary-access window. Callers must
 * invoke this only after locking the household row, so both validation and the
 * database trigger observe the same timezone.
 *
 * `undefined` means the field was not supplied; null clears the access window.
 */
export function canonicalAccessWindow(
  input: { accessEndsOn?: unknown; accessExpiresAt?: unknown },
  householdTimezone: string,
  now: Date = new Date()
): CanonicalAccessWindow | null {
  const hasEndDate = input.accessEndsOn !== undefined
  const hasLegacyExpiry = input.accessExpiresAt !== undefined
  if (!hasEndDate && !hasLegacyExpiry) return null
  if (hasEndDate && hasLegacyExpiry) {
    throw new AccessEndDateError('send accessEndsOn instead of accessExpiresAt, not both')
  }

  if (hasEndDate) {
    const expiry = expiryAfterAccessEndDate(input.accessEndsOn, householdTimezone, now)
    return { accessEndsOn: expiry ? input.accessEndsOn as string : null, accessExpiresAt: null }
  }

  if (input.accessExpiresAt === null) {
    return { accessEndsOn: null, accessExpiresAt: null }
  }
  if (typeof input.accessExpiresAt !== 'string' || !input.accessExpiresAt.trim()) {
    throw new AccessEndDateError('accessExpiresAt must be null or a future ISO date')
  }
  const instant = DateTime.fromISO(input.accessExpiresAt, { setZone: true })
  if (!instant.isValid || instant.toMillis() <= now.getTime()) {
    throw new AccessEndDateError('accessExpiresAt must be null or a future ISO date')
  }

  const accessEndsOn = accessEndDateBeforeExpiry(input.accessExpiresAt, householdTimezone)
  // The legacy instant may be in the future while its conservative civil-date
  // canonicalization is already in the past. Never persist an immediately
  // inactive membership/invite and report success.
  expiryAfterAccessEndDate(accessEndsOn, householdTimezone, now)
  return { accessEndsOn, accessExpiresAt: null }
}
