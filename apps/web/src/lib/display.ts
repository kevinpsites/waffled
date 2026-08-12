// Household display settings — how event chips are colored across the calendar
// views. 'solid' (full-color blocks; the default, and the most glanceable from
// across the kitchen) or 'tinted' (a soft wash with colored text). Stored in
// households.settings.display and stamped onto the document root as
// `data-ev-style` (same trick as `data-theme` in theme.ts) so styles/waffled.css
// can switch every `.ev-tint` chip in pure CSS.
import type { Household } from './api/persons'

export type EventStyle = 'solid' | 'tinted'

/** Resolve the household's event style; anything but an explicit 'tinted' is solid. */
export function eventStyle(household: Household | null | undefined): EventStyle {
  const v = (household?.settings as { display?: { eventStyle?: unknown } } | undefined)?.display?.eventStyle
  return v === 'tinted' ? 'tinted' : 'solid'
}

/** Stamp the style onto <html data-ev-style> (always, so the CSS keys stay simple). */
export function applyEventStyle(style: EventStyle): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-ev-style', style)
  }
}
