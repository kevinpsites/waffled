// Theme store — light / dark / follow-the-OS.
//
// The palette lives entirely in CSS custom properties (styles/waffled.css). This
// module only decides which resolved theme is active and stamps it onto the
// document root as `data-theme="light|dark"`, which the `:root[data-theme="dark"]`
// override block keys off of. Nothing here knows about individual colors.
//
// Preference model:
//   'light' | 'dark'  → pinned, ignores the OS
//   'system'          → mirrors prefers-color-scheme and follows live OS changes
// Default is 'system' so a fresh install matches the device out of the box.
//
// The typeface is a second, independent axis, `data-typeface`, which swaps
// `--sans`/`--serif` (styles/typefaces.css). 'classic' removes it so the
// palette's own fonts return.

import { useSyncExternalStore } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export type Typeface = 'classic' | 'clear' | 'hyperlegible' | 'friendly' | 'early-reader'
export const TYPEFACE_IDS: readonly Typeface[] = ['classic', 'clear', 'hyperlegible', 'friendly', 'early-reader']

export const THEME_KEY = 'waffled:theme'
export const TYPEFACE_KEY = 'waffled:typeface'
const DARK_MQ = '(prefers-color-scheme: dark)'

/** The stored preference, defaulting to 'system' (also for any garbage value). */
export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts — treat as unset.
  }
  return 'system'
}

/** Whether the OS currently prefers a dark color scheme. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DARK_MQ).matches
}

/** Resolve a preference to a concrete theme (an explicit choice always wins). */
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return systemPrefersDark() ? 'dark' : 'light'
}

/** Stamp the resolved theme onto <html data-theme>. */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
  }
}

/** Persist a preference, apply it, and notify listeners (e.g. the Settings UI). */
export function setPref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
  applyTheme(resolveTheme(pref))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('waffled:theme-changed'))
  }
}

/** The stored typeface, defaulting to 'classic' (also for any garbage value). */
export function readTypeface(): Typeface {
  try {
    const v = localStorage.getItem(TYPEFACE_KEY)
    if (v && (TYPEFACE_IDS as readonly string[]).includes(v)) return v as Typeface
  } catch {
    // Same private-mode caveat as readPref.
  }
  return 'classic'
}

export function applyTypeface(typeface: Typeface): void {
  if (typeof document === 'undefined') return
  if (typeface === 'classic') document.documentElement.removeAttribute('data-typeface')
  else document.documentElement.setAttribute('data-typeface', typeface)
}

/** Persist a typeface, apply it, and notify listeners. */
export function setTypeface(typeface: Typeface): void {
  try {
    if (typeface === 'classic') localStorage.removeItem(TYPEFACE_KEY)
    else localStorage.setItem(TYPEFACE_KEY, typeface)
  } catch {
    // Non-fatal: the choice just won't survive a reload.
  }
  applyTypeface(typeface)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('waffled:theme-changed'))
  }
}

// Apply the stored preference and wire up the OS listener so 'system' tracks
// live prefers-color-scheme changes. Explicit light/dark ignore the OS. Called
// once at startup; applyTheme is idempotent so a stray re-call is harmless.
export function initTheme(): void {
  applyTheme(resolveTheme(readPref()))
  applyTypeface(readTypeface())
  if (typeof window === 'undefined' || !window.matchMedia) return
  const mq = window.matchMedia(DARK_MQ)
  const onChange = () => {
    if (readPref() === 'system') applyTheme(resolveTheme('system'))
  }
  // addEventListener is standard; addListener is the legacy Safari fallback.
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else if (mq.addListener) mq.addListener(onChange)
}

// --- React binding -----------------------------------------------------------

function subscribe(cb: () => void): () => void {
  window.addEventListener('waffled:theme-changed', cb)
  const mq = window.matchMedia?.(DARK_MQ)
  // addEventListener is standard; addListener is the legacy Safari < 14 fallback —
  // mirror initTheme() so useThemePref() consumers re-render on a live OS flip there too.
  if (mq?.addEventListener) mq.addEventListener('change', cb)
  else if (mq?.addListener) mq.addListener(cb)
  return () => {
    window.removeEventListener('waffled:theme-changed', cb)
    if (mq?.removeEventListener) mq.removeEventListener('change', cb)
    else if (mq?.removeListener) mq.removeListener(cb)
  }
}

// Snapshot encodes BOTH the preference and the resolved theme, so a live OS flip
// (pref stays 'system' but resolved changes) still produces a new snapshot and
// re-renders — a bare pref snapshot would be identical and bail out.
function snapshot(): string {
  const p = readPref()
  return `${p}|${resolveTheme(p)}|${readTypeface()}`
}

export function useThemePref(): {
  pref: ThemePref
  resolved: ResolvedTheme
  typeface: Typeface
  setPref: (p: ThemePref) => void
  setTypeface: (t: Typeface) => void
} {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'system|light|classic')
  const [pref, resolved, typeface] = snap.split('|') as [ThemePref, ResolvedTheme, Typeface]
  return { pref, resolved, typeface, setPref, setTypeface }
}
