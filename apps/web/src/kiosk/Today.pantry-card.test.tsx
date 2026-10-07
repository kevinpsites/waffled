import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PantryCard } from './PantryCard'

// Today is the index route, so everything in its *static* import graph is downloaded
// by every household on every cold start. Pantry is an optional module that defaults
// to off, and its screen is 600 lines — importing the card from it put the whole
// screen on the critical path for households that never enabled the module.
//
// The card now lives in its own module and Today loads it lazily, so a household with
// pantry off never fetches it at all.

const HERE = resolve(__dirname)

// Follow only *static* imports: `import(...)` is what we're relying on to break the
// edge, and `import type` is erased before it reaches the bundler.
function staticImportsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const specifiers: string[] = []
  const re = /(?:^|\n)\s*import\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) specifiers.push(m[1])
  return specifiers
}

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      // A bare directory match isn't a module; only accept real files.
      if (candidate === base && !/\.(tsx?|css)$/.test(candidate)) continue
      return candidate
    }
  }
  return null
}

function staticGraphFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue
    seen.add(file)
    for (const spec of staticImportsOf(file)) {
      const target = resolveModule(file, spec)
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  return seen
}

test('the Pantry screen is not in Today’s static import graph', () => {
  const graph = staticGraphFrom(resolve(HERE, 'Today.tsx'))
  // Sanity-check the walker itself: a card Today genuinely does import statically
  // must show up, or an empty graph would make the real assertion vacuous.
  expect(graph.has(resolve(HERE, 'components/AgendaCard.tsx'))).toBe(true)
  expect(graph.has(resolve(HERE, 'Pantry.tsx'))).toBe(false)
})

test('the pantry card is loaded lazily, not statically', () => {
  const src = readFileSync(resolve(HERE, 'Today.tsx'), 'utf8')
  expect(src).toMatch(/import\(['"]\.\/PantryCard['"]\)/)
})

// And the extracted card still works. It renders nothing until its fetch lands, which
// is why Today can use a null Suspense fallback without anything visibly popping in.
const realFetch = global.fetch
beforeEach(() => {
  global.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        items: [
          { id: 'i1', name: 'Rice', amount: '2', unit: 'lb', expiresOn: null, usedUp: false },
          { id: 'i2', name: 'Milk', amount: null, unit: null, expiresOn: null, usedUp: true },
        ],
        locations: [], showOnToday: true, avoidAllergens: [], allergenPeople: {},
        lowThreshold: 1, locationIcons: {}, staleMonths: 6,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  ) as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = realFetch
})

test('renders the on-hand items, skipping ones already used up', async () => {
  render(
    <MemoryRouter>
      <PantryCard />
    </MemoryRouter>
  )
  await waitFor(() => expect(screen.getByText('Rice')).toBeTruthy())
  expect(screen.getByText('1 on hand')).toBeTruthy()
  expect(screen.queryByText('Milk')).toBeNull()
})
