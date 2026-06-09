import '@testing-library/jest-dom/vitest'
import { vi, beforeEach } from 'vitest'

// Default: no network — empty family + empty grocery list. Tests that exercise
// data override globalThis.fetch themselves.
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ persons: [], items: [], people: [] }),
  })) as unknown as typeof fetch
})
