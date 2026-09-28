/** A stored "HH:MM" (seconds ignored) as the time people say: "17:00" → "5:00 PM". Anything
 *  that isn't a time comes back unchanged. */
export function clockLabel(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  if (!m) return hhmm
  const h = Number(m[1])
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}
