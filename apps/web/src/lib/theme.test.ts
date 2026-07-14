import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  readPref,
  setPref,
  resolveTheme,
  applyTheme,
  initTheme,
  THEME_KEY,
  type ThemePref,
} from './theme'

// A controllable fake of window.matchMedia('(prefers-color-scheme: dark)').
function installMatchMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    // legacy Safari
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  }
  window.matchMedia = vi.fn().mockImplementation(() => mql) as unknown as typeof window.matchMedia
  return {
    // Flip the OS preference and notify subscribers, like the real MQL would.
    set(next: boolean) {
      mql.matches = next
      listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent))
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('theme store', () => {
  it('defaults to "system" when nothing is stored', () => {
    expect(readPref()).toBe('system')
  })

  it('persists a chosen preference to localStorage', () => {
    installMatchMedia(false)
    setPref('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(readPref()).toBe('dark')
  })

  it('ignores a garbage stored value and falls back to "system"', () => {
    localStorage.setItem(THEME_KEY, 'chartreuse')
    expect(readPref()).toBe('system')
  })

  it('resolves an explicit preference regardless of the OS setting', () => {
    installMatchMedia(true) // OS says dark…
    expect(resolveTheme('light')).toBe('light') // …but explicit light wins
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('resolves "system" from the OS media query', () => {
    const mm = installMatchMedia(false)
    expect(resolveTheme('system')).toBe('light')
    mm.set(true)
    expect(resolveTheme('system')).toBe('dark')
  })

  it('applyTheme sets data-theme on the document root', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('setPref applies the resolved theme to the DOM immediately', () => {
    installMatchMedia(false)
    setPref('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    setPref('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('setPref("system") reflects the current OS preference', () => {
    installMatchMedia(true)
    setPref('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('initTheme applies the stored preference on boot', () => {
    installMatchMedia(false)
    localStorage.setItem(THEME_KEY, 'dark')
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('follows live OS changes only while preference is "system"', () => {
    const mm = installMatchMedia(false)
    localStorage.setItem(THEME_KEY, 'system')
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    mm.set(true) // OS flips to dark
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // Pin to light — OS changes must no longer move the theme.
    setPref('light')
    mm.set(false)
    mm.set(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('emits a waffled:theme-changed event on setPref', () => {
    installMatchMedia(false)
    const spy = vi.fn()
    window.addEventListener('waffled:theme-changed', spy)
    setPref('dark')
    expect(spy).toHaveBeenCalledOnce()
    window.removeEventListener('waffled:theme-changed', spy)
  })
})

// Type-only guard: ThemePref is the three-value union we expect.
const _pref: ThemePref[] = ['light', 'dark', 'system']
void _pref
