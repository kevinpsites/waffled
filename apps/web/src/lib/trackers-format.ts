// Assembled from formatToParts: some ICU builds put U+202F before AM/PM, and the copy
// contract is a plain space.
export function formatEntryTime(occurredAt: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(occurredAt))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`
}

export function formatLastTime(
  entry: { occurredAt: string; personName: string | null } | null,
  tz: string,
): string {
  if (!entry) return 'Not logged yet'
  const text = `Last time: ${formatEntryTime(entry.occurredAt, tz)}`
  return entry.personName ? `${text} · ${entry.personName}` : text
}

// datetime-local carries no zone, so the edit field is bound to household wall time:
// these two convert between that and the ISO instant the API stores.
function zonedParts(ms: number, tz: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms))
  const out: Record<string, number> = {}
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

export function isoToZonedInput(iso: string, tz: string): string {
  const p = zonedParts(new Date(iso).getTime(), tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

export function zonedInputToIso(value: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  // Two passes: the offset at the guess may differ from the offset at the real instant (DST edge).
  let ms = asUtc
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(ms, tz)
    ms += asUtc - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  }
  return new Date(ms).toISOString()
}
