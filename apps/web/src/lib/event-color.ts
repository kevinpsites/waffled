// Event → color resolution, family-aware: an event whose people cover the whole household
// renders in the household's *family* color (settings.display.familyColorHex) instead of
// whichever member owned it.
import { useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { personsApi, HOUSEHOLD_CHANGED, type Household, type Person } from './api/persons'

export const UNASSIGNED_COLOR = '#6B6B70'
/** Default whole-family color — deliberately not one of the member swatches. */
export const DEFAULT_FAMILY_COLOR = '#F97316'

const HEX = /^#[0-9a-fA-F]{6}$/

export interface ColorableEvent {
  personId: string | null
  personColor: string | null
  /** Only the ids are read, so a caller holding ids alone can use the same resolver. */
  participants?: { id: string }[] | null
}

export function familyColorHex(household: Household | null | undefined): string {
  const v = (household?.settings as { display?: { familyColorHex?: unknown } } | undefined)?.display?.familyColorHex
  return typeof v === 'string' && HEX.test(v) ? v : DEFAULT_FAMILY_COLOR
}

/** Its people (participants + owner) cover every member. One-person households never
 *  qualify — there is no whole-vs-part distinction to draw. */
export function isFamilyEvent(e: Pick<ColorableEvent, 'personId' | 'participants'>, memberIds: string[]): boolean {
  if (memberIds.length < 2) return false
  const ids = new Set((e.participants ?? []).map((p) => p.id))
  if (e.personId) ids.add(e.personId)
  return memberIds.every((id) => ids.has(id))
}

/** Family color for whole-family events; else the owner's color; else grey. */
export function eventColor(
  e: ColorableEvent,
  memberIds: string[],
  household: Household | null | undefined,
  fallback: string = UNASSIGNED_COLOR
): string {
  if (isFamilyEvent(e, memberIds)) return familyColorHex(household)
  return e.personColor ?? fallback
}

/* ── chip painting ────────────────────────────────────────────────────────────
   Solid chips fill with the event's color, so the *foreground* can't be a fixed
   white: gold and teal are too light for it. Each chip picks black or white by
   APCA contrast on the fill it actually gets, in both themes. WCAG 2's ratio
   narrowly chose black on purple and blue, which reads worse; APCA keeps black
   only where white genuinely fails, and the winner is always at least Lc 54
   (the black/white crossover), so the stylesheet just consumes it.            */

/** Dark mode mixes the fill toward black; keep in step with styles/waffled.css. */
export const SOLID_DARK_MIX = 0.82

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = ([r, g, b]: [number, number, number]): string =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

/** WCAG relative luminance of a #RRGGBB color. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two #RRGGBB colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return 1
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The fill a solid chip actually gets, per theme (mirrors styles/waffled.css). */
export function solidChipBackground(color: string, theme: 'light' | 'dark'): string {
  const rgb = parseHex(color)
  if (!rgb || theme === 'light') return color
  return toHex(rgb.map((c) => c * SOLID_DARK_MIX) as [number, number, number])
}

/** APCA lightness contrast (|Lc|, 0 to ~106) of text on a background, both #RRGGBB; 0 if malformed. */
export function apcaContrast(text: string, background: string): number {
  const t = parseHex(text)
  const b = parseHex(background)
  if (!t || !b) return 0
  const y = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((c) => (c / 255) ** 2.4)
    const v = 0.2126729 * r + 0.7151522 * g + 0.072175 * bl
    return v > 0.022 ? v : v + (0.022 - v) ** 1.414
  }
  const yt = y(t)
  const yb = y(b)
  const sapc = yb > yt ? (yb ** 0.56 - yt ** 0.57) * 1.14 : (yb ** 0.65 - yt ** 0.62) * 1.14
  return Math.abs(sapc) < 0.1 ? 0 : (Math.abs(sapc) - 0.027) * 100
}

/** Black or white — whichever reads better on that fill, by APCA. */
function inkFor(background: string): string {
  return apcaContrast('#FFFFFF', background) >= apcaContrast('#000000', background) ? '#FFFFFF' : '#000000'
}

export function solidChipInk(color: string): { light: string; dark: string } {
  return { light: inkFor(solidChipBackground(color, 'light')), dark: inkFor(solidChipBackground(color, 'dark')) }
}

/** Spread into a chip's `style`: the stylesheet reads `--ev` for the fill/wash and
 *  `--ev-on` / `--ev-on-dark` for solid text. */
export function evVars(color: string): CSSProperties {
  if (!parseHex(color)) return { '--ev': color } as CSSProperties
  const ink = solidChipInk(color)
  return { '--ev': color, '--ev-on': ink.light, '--ev-on-dark': ink.dark } as CSSProperties
}

/* ── the shared source behind useEventColor ───────────────────────────────────
   Resolving a chip's color needs the member list (does this event cover the whole
   family?) and the household (what is the family color?). Seven components ask
   for it — month, week, day, agenda, the month's day panel, the Today agenda card
   and the event detail — and per-instance hooks meant a fetch pair per view plus a
   HOUSEHOLD_CHANGED listener each, so one settings save cost seven household
   refetches on an always-on kiosk. One module-level store serves them all, loads
   once while anyone is mounted, and resets when the last consumer unmounts (so a
   screen never opens on a previous session's household).                      */

interface EventColorSource {
  persons: Person[]
  household: Household | null
}

const EMPTY: EventColorSource = { persons: [], household: null }
let source: EventColorSource = EMPTY
let generation = 0
const listeners = new Set<() => void>()

async function loadSource(): Promise<void> {
  const mine = generation
  const [persons, household] = await Promise.all([
    personsApi.persons().then((d) => d.persons ?? []).catch(() => source.persons),
    personsApi.household().then((d) => d.household ?? null).catch(() => source.household),
  ])
  if (mine !== generation) return // the last consumer unmounted mid-flight
  source = { persons, household }
  for (const notify of [...listeners]) notify()
}

const reload = () => void loadSource()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (listeners.size === 1) {
    window.addEventListener(HOUSEHOLD_CHANGED, reload)
    reload()
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) {
      window.removeEventListener(HOUSEHOLD_CHANGED, reload)
      generation++
      source = EMPTY
    }
  }
}

export function useEventColorSource(): EventColorSource {
  return useSyncExternalStore(
    subscribe,
    () => source,
    () => EMPTY
  )
}

/** Hook form for the calendar views. `fallback` is the unassigned grey; falls back to the
 *  plain owner color while members/household are still loading. */
export function useEventColor(fallback: string = UNASSIGNED_COLOR): (e: ColorableEvent) => string {
  const { persons, household } = useEventColorSource()
  return useMemo(() => {
    const ids = persons.map((p) => p.id)
    return (e: ColorableEvent) => eventColor(e, ids, household, fallback)
  }, [persons, household, fallback])
}
