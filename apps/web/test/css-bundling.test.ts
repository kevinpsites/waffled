import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Read the config as text rather than importing it: importing vite.config pulls in
// esbuild, which refuses to run under this suite's jsdom environment, and switching
// this file to the node environment then breaks on the shared jsdom setup file.
const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../vite.config.ts')

// Splitting the screens into their own chunks also splits their stylesheets, and a
// stylesheet only loads with the chunk that imports it. An audit of this codebase
// found 53 classes defined in one screen's stylesheet but used from another — 13
// `cc-*` for CookConfirm living in pantry.css, 10 pantry-*/pl-* used from Settings,
// the 12-class recipe picker, 7 re-timer-* used from CookMode, and ~9 genuine
// design-system primitives stranded in settings.css. `.cal-search` ended up loading
// on none of the screens that use it at all.
//
// Each one renders as an unstyled browser default until the owning screen happens to
// be opened first in that page session — the failure apps/web/CLAUDE.md puts first,
// and one no unit test can see. Keeping a single stylesheet costs ~28 kB gzipped on
// first load out of a ~373 kB saving, and makes the whole class of bug impossible,
// including for classes nobody has written yet.
//
// Re-enabling the split means first moving those 53 classes to the chunks that use
// them. This test exists so that has to be a decision rather than an accident.
describe('CSS bundling', () => {
  it('keeps every stylesheet in one file', () => {
    expect(readFileSync(configPath, 'utf8')).toMatch(/cssCodeSplit:\s*false/)
  })
})
