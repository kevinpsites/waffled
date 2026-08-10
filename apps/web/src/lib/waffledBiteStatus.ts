// A device is considered online if it reported in within this window — wider
// than the firmware's ~4-minute token-refresh cadence (see
// wb_wifi_esp32.cpp / waffledBites.ts's lastSeenAt update) so a single missed
// refresh cycle (a brief WiFi blip) doesn't flash "Offline" — two misses in a
// row is a genuine signal something's actually wrong.
export const WB_OFFLINE_AFTER_MS = 10 * 60 * 1000

export function wbIsOnline(lastSeenAt: string | null, nowMs: number): boolean {
  if (!lastSeenAt) return false
  const seenMs = new Date(lastSeenAt).getTime()
  if (Number.isNaN(seenMs)) return false
  return nowMs - seenMs <= WB_OFFLINE_AFTER_MS
}
