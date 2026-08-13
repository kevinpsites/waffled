// Solid event chips must stay readable. The chip fill is the person's (or the
// family's) color, so a fixed white foreground fails WCAG AA on most of the
// palette — gold and teal are barely 2.2–2.5:1. Every chip therefore carries the
// foreground that wins on *its* fill (`--ev-on` / `--ev-on-dark`), and this spec
// pins the contract from both ends:
//
//   1. the math — every preset, the family default, the unassigned grey, and
//      adversarial custom hexes clear 4.5:1 in light *and* dark;
//   2. the stylesheet — the solid rules really consume those custom properties
//      and mix the dark fill by exactly the ratio the math assumes. Without (2)
//      a revert to `color: var(--on-accent)` would leave (1) green and the
//      calendar illegible.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COLOR_SWATCHES } from '../kiosk/components/ColorPicker'
import {
  DEFAULT_FAMILY_COLOR,
  UNASSIGNED_COLOR,
  SOLID_DARK_MIX,
  contrastRatio,
  solidChipBackground,
  solidChipInk,
  evVars,
} from './event-color'

const AA = 4.5

// Read the stylesheet as text (Vitest stubs CSS imports to an empty string, so
// `?raw` won't do); vitest runs from apps/web, but tolerate a repo-root run.
const STYLESHEET = ['src/styles/waffled.css', 'apps/web/src/styles/waffled.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p))!
const CSS = readFileSync(STYLESHEET, 'utf8')

/** The declaration block for a selector, as written in styles/waffled.css. */
function ruleFor(selectorFragment: string): string {
  const at = CSS.indexOf(selectorFragment)
  expect(at, `selector not found: ${selectorFragment}`).toBeGreaterThan(-1)
  const open = CSS.indexOf('{', at)
  return CSS.slice(open + 1, CSS.indexOf('}', open))
}

/** A design-token value (`--ink-3`) from the light root or the dark override. */
function token(name: string, theme: 'light' | 'dark'): string {
  const hits = [...CSS.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim())
  expect(hits.length, `${name} should be defined for light and dark`).toBeGreaterThan(1)
  return theme === 'light' ? hits[0] : hits[1]
}

// Everything a household can end up with: the eight presets, the two built-in
// colors, plus custom hexes — a near-crossover grey (the worst case any color
// can produce), a pale wash, and near-black.
const CASES = [...COLOR_SWATCHES, DEFAULT_FAMILY_COLOR, UNASSIGNED_COLOR, '#757575', '#FFF3B0', '#111111']

describe('solid event chips clear WCAG AA on every color', () => {
  it.each(CASES)('%s is readable in light and dark', (hex) => {
    const ink = solidChipInk(hex)
    expect(contrastRatio(solidChipBackground(hex, 'light'), ink.light)).toBeGreaterThanOrEqual(AA)
    expect(contrastRatio(solidChipBackground(hex, 'dark'), ink.dark)).toBeGreaterThanOrEqual(AA)
  })

  it('ships the eight presets it thinks it does', () => {
    expect(COLOR_SWATCHES).toHaveLength(8)
  })

  it('hands the chip its foreground as inline custom properties', () => {
    const vars = evVars('#E0A500') as unknown as Record<string, string>
    expect(vars['--ev']).toBe('#E0A500')
    expect(vars['--ev-on']).toBe(solidChipInk('#E0A500').light)
    expect(vars['--ev-on-dark']).toBe(solidChipInk('#E0A500').dark)
  })

  it('leaves the foreground to the stylesheet when the color is unparseable', () => {
    const vars = evVars('var(--primary)') as unknown as Record<string, string>
    expect(vars['--ev']).toBe('var(--primary)')
    expect(vars['--ev-on']).toBeUndefined()
    expect(vars['--ev-on-dark']).toBeUndefined()
  })
})

describe('the solid rules in styles/waffled.css consume that foreground', () => {
  const light = ruleFor(':root[data-ev-style="solid"] .ev-tint {')
  const dark = ruleFor(':root[data-ev-style="solid"][data-theme="dark"] .ev-tint,')

  it('paints the light fill with --ev and its matching ink', () => {
    expect(light).toMatch(/background:\s*var\(--ev,/)
    expect(light).toMatch(/color:\s*var\(--ev-on,/)
    expect(light).not.toMatch(/color:\s*var\(--on-accent\)/)
  })

  it('paints the dark fill with the dark ink, for both dark selectors', () => {
    expect(CSS).toContain(':root[data-ev-style="solid"] .dark .ev-tint')
    expect(dark).toMatch(/color:\s*var\(--ev-on-dark,/)
    expect(dark).not.toMatch(/color:\s*var\(--on-accent\)/)
  })

  it('mixes the dark fill by exactly the ratio the contrast math assumes', () => {
    const mix = /color-mix\(in srgb,\s*var\(--ev,.*?\s([\d.]+)%,\s*black\)/.exec(dark)
    expect(mix, 'dark solid rule should mix --ev toward black').toBeTruthy()
    expect(Number(mix![1]) / 100).toBeCloseTo(SOLID_DARK_MIX, 5)
  })

  it('keeps a readable fallback when a chip carries no --ev at all', () => {
    // The rules fall back to --ink-3; the hardcoded ink in the fallback has to
    // survive that too, in both themes.
    const lightInk = /color:\s*var\(--ev-on,\s*([^)]+)\)/.exec(light)![1].trim()
    const darkInk = /color:\s*var\(--ev-on-dark,\s*([^)]+)\)/.exec(dark)![1].trim()
    expect(contrastRatio(solidChipBackground(token('--ink-3', 'light'), 'light'), lightInk)).toBeGreaterThanOrEqual(AA)
    expect(contrastRatio(solidChipBackground(token('--ink-3', 'dark'), 'dark'), darkInk)).toBeGreaterThanOrEqual(AA)
  })
})

describe('the tinted style keeps its (already good) contrast', () => {
  it('still derives both the wash and the text from --ev', () => {
    const tint = ruleFor('\n.ev-tint {')
    expect(tint).toMatch(/background:\s*color-mix\(in srgb, var\(--ev/)
    expect(tint).toMatch(/color:\s*color-mix\(in srgb, var\(--ev/)
  })
})
