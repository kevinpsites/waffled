import { DateTime, IANAZone } from 'luxon'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export class AccessEndDateError extends Error {}

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
