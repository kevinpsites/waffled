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

import { useSyncExternalStore } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_KEY = 'waffled:theme'
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

// Apply the stored preference and wire up the OS listener so 'system' tracks
// live prefers-color-scheme changes. Explicit light/dark ignore the OS. Called
// once at startup; applyTheme is idempotent so a stray re-call is harmless.
export function initTheme(): void {
  applyTheme(resolveTheme(readPref()))
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
  mq?.addEventListener?.('change', cb)
  return () => {
    window.removeEventListener('waffled:theme-changed', cb)
    mq?.removeEventListener?.('change', cb)
  }
}

// Snapshot encodes BOTH the preference and the resolved theme, so a live OS flip
// (pref stays 'system' but resolved changes) still produces a new snapshot and
// re-renders — a bare pref snapshot would be identical and bail out.
function snapshot(): string {
  const p = readPref()
  return `${p}|${resolveTheme(p)}`
}

export function useThemePref(): {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (p: ThemePref) => void
} {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'system|light')
  const [pref, resolved] = snap.split('|') as [ThemePref, ResolvedTheme]
  return { pref, resolved, setPref }
}
