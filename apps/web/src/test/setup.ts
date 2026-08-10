import '@testing-library/jest-dom/vitest'
import { vi, beforeEach } from 'vitest'

class TestStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(String(key)) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(String(key))
  }

  setItem(key: string, value: string) {
    this.values.set(String(key), String(value))
  }
}

// Node 26 exposes an unavailable experimental localStorage global that can
// shadow jsdom's implementation. Own the test storage explicitly so all
// supported Node versions exercise the same browser contract.
const testLocalStorage = new TestStorage()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
})
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
})

// Default: no network — empty family + empty grocery list. Tests that exercise
// data override globalThis.fetch themselves.
beforeEach(() => {
  testLocalStorage.clear()
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ persons: [], items: [], lists: [], people: [], instances: [], entries: [], events: [], goals: [], photos: [], recipes: [] }),
  })) as unknown as typeof fetch
})
