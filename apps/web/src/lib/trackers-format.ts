// Assembled from formatToParts: some ICU builds put U+202F before AM/PM, and the copy
// contract is a plain space.
export function formatLastTime(
  entry: { occurredAt: string; personName: string | null } | null,
  tz: string,
): string {
  if (!entry) return 'Not logged yet'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(entry.occurredAt))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const text = `Last time: ${get('month')}/${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`
  return entry.personName ? `${text} · ${entry.personName}` : text
}
