import '@testing-library/jest-dom/vitest'
import { vi, beforeEach } from 'vitest'

// Default: no network — return an empty family. Tests that exercise data
// override globalThis.fetch themselves.
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ persons: [] }),
  })) as unknown as typeof fetch
})
