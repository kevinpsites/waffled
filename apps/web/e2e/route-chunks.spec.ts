import { expect, test, type Page } from '@playwright/test'

// Every screen is now fetched as its own chunk at navigation time, and the kiosk's
// offline copy is built from the build manifest. Neither of those exists under
// vitest: jsdom imports modules directly, so all 935 unit tests would stay green if
// every chunk in the build 404'd. This spec drives the real production bundle in a
// real browser, which is the only place the split can actually be observed.
//
// It covers the two things that can now break and could not before:
//   1. a screen whose chunk fails to fetch, parse, or resolve its named export
//   2. a display that goes offline and finds a screen missing from its precache

const person = {
  id: 'person-1',
  name: 'Alex',
  memberType: 'adult',
  isAdmin: true,
  avatarEmoji: 'A',
  colorHex: '#4f7f73',
  capabilities: ['chore.manage', 'chore.approve', 'goal.manage'],
}

// Every optional module on, so the gated routes actually render their screen
// instead of redirecting to Today — a redirect would never load the chunk, and the
// test would pass while proving nothing.
const modules = {
  pantry: true,
  chores: true,
  goals: true,
  meals: true,
  lists: true,
  familyNight: true,
  quotes: true,
}

const household = {
  id: 'household-1',
  name: 'Test Household',
  timezone: 'America/Denver',
  weekStart: 'sunday',
  location: null,
  ownerPersonId: person.id,
  settings: {
    modules,
    chores: { rewards: false },
    pantry: { showOnToday: false },
    familyNight: { showOnToday: false },
  },
}

const capabilities = [
  'chore.manage', 'chore.approve', 'reward.manage', 'reward.approve',
  'reward.grant', 'reward.correct', 'goal.manage',
]
const permissionRow = Object.fromEntries(capabilities.map((capability) => [capability, false]))
const permissions = {
  adult: permissionRow,
  caregiver: permissionRow,
  guest: permissionRow,
  teen: permissionRow,
  kid: permissionRow,
}
const empty = {
  balances: [], chores: [], countdowns: [], currencies: [], entries: [], events: [],
  goals: [], groups: [], instances: [], items: [], lists: [], meals: [], members: [],
  people: [], persons: [], photos: [], recipes: [], rewards: [], suggestions: [],
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = empty

    if (path === '/api/auth/status') body = { initialized: true, methods: ['password'] }
    else if (path === '/api/auth/login') body = {
      accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900,
      memberType: 'adult', accessExpiresAt: null,
    }
    else if (path === '/api/household') body = { provisioned: true, household, person, memberships: [], pendingInvites: [] }
    else if (path === '/api/household/settings') {
      body = {
        household,
        members: [{ ...person, hasLogin: true, loginEmail: 'alex@example.test', hasPassword: true, hasPin: false, isOwner: true }],
      }
    } else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = {
      permissions,
      capabilities,
      roles: ['adult', 'caregiver', 'guest', 'teen', 'kid'],
    }
    else if (path === '/api/weather') body = { weather: null }
    else if (path === '/api/updates') body = { enabled: false, updateAvailable: false }
    else if (path === '/api/calendar/status') body = { connected: false, configured: false }
    else if (path === '/api/powersync/token') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'disabled in browser tests' }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Welcome back')).toBeVisible()
  await page.locator('input[type="email"]').fill('alex@example.test')
  await page.locator('input[type="password"]').fill('not-a-real-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation')).toBeVisible()
}

// Every path in routes.tsx, with ids for the parameterised ones. All twenty lazy
// screens appear at least once.
//
// `throwsOnEmptyFixture` marks screens that crash while *rendering* against the
// blanket empty payload this file mocks — Lists, for one, does `.find` on a field
// the fixture doesn't model. That is a limitation of the fixture, not a broken
// screen: batch-visual.spec.ts and pantry-grocery-visual.spec.ts render these same
// screens happily with realistic data. Marking them keeps the chunk assertions
// (which apply to all 24 paths and are what this PR can actually break) honest
// instead of quietly weakening them to accommodate a fixture gap.
const ROUTES: Array<{ path: string; throwsOnEmptyFixture?: true }> = [
  { path: '/' },
  { path: '/calendar' },
  { path: '/calendar/event/event-1' },
  { path: '/tasks' },
  { path: '/goals' },
  { path: '/goals/new' },
  { path: '/goals/goal-1' },
  { path: '/goals/goal-1/edit' },
  { path: '/family' },
  { path: '/person/person-1', throwsOnEmptyFixture: true },
  { path: '/person/person-1/waffled-bite' },
  { path: '/meals' },
  { path: '/meals/recipes' },
  { path: '/meals/build' },
  { path: '/meals/build/meal-1' },
  { path: '/meals/recipe/new', throwsOnEmptyFixture: true },
  { path: '/meals/recipe/recipe-1' },
  { path: '/meals/recipe/recipe-1/edit', throwsOnEmptyFixture: true },
  { path: '/meals/recipe/recipe-1/cook' },
  { path: '/meals/meal/meal-1/cook' },
  { path: '/lists', throwsOnEmptyFixture: true },
  { path: '/pantry', throwsOnEmptyFixture: true },
  { path: '/photos' },
  { path: '/settings' },
]

test.beforeEach(async ({ page }) => {
  await mockApi(page)
})

test('every screen loads its own chunk without falling back to the error card', async ({ page }) => {
  const problems: string[] = []
  let current = '(before navigation)'

  // A chunk that 404s or comes back as the SPA fallback shows up here first.
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/assets/') && response.status() >= 400) {
      problems.push(`${current}: ${path} returned ${response.status()}`)
    }
  })
  // "Failed to fetch dynamically imported module" surfaces as an uncaught error.
  page.on('pageerror', (error) => {
    problems.push(`${current}: uncaught ${error.message}`)
  })

  await signIn(page)

  for (const route of ROUTES) {
    current = route.path
    await page.goto(route.path)
    // The shell is eager, so it renders even when a screen chunk dies — which is
    // exactly why its presence alone is not evidence the screen loaded.
    await expect(page.getByRole('navigation')).toBeVisible()
    // ScreenBoundary's fallback. If this is up, the screen threw rather than rendered.
    //
    // Matched with a regex on purpose: the copy uses a typographic apostrophe, and an
    // ASCII one here silently matches nothing — the check passes while the screen is
    // broken. That is exactly what happened the first time this was written, and the
    // suite reported all 24 routes healthy while Lists was showing the error card.
    // Give the screen a beat to render and throw; the chrome appears before it does.
    await page.waitForTimeout(400)
    // count(), not isVisible(): isVisible() throws under strict mode when a locator
    // resolves to more than one node, and wrapping that in .catch(() => false) turns
    // a broken screen into a pass. Between that and matching the copy's typographic
    // apostrophe with an ASCII one, this check reported all 24 routes healthy while
    // five were visibly showing the error card.
    const boundaryShown = (await page.getByText(/This screen couldn.t load/).count()) > 0
    if (boundaryShown && !route.throwsOnEmptyFixture) {
      problems.push(`${route.path}: rendered the ScreenBoundary error card`)
    }
    // And the reverse: if a screen we expect to throw stops throwing, the marker is
    // stale and is now hiding a real regression on that route.
    if (!boundaryShown && route.throwsOnEmptyFixture) {
      problems.push(`${route.path}: no longer throws on the empty fixture — drop its marker`)
    }
  }

  // Report every broken route at once — failing on the first would hide the rest,
  // and "one screen is broken" and "twelve are" call for very different responses.
  expect(problems).toEqual([])
})

test('a screen nobody opened still works after the display goes offline', async ({ page, context }) => {
  // The whole point of precaching from the build manifest. Before that, the worker
  // scraped index.html — which cannot name a code-split chunk — so a kiosk that lost
  // its network could open Today and nothing else. Settings is never visited here
  // before the network is cut, so its chunk can only come from the precache.
  await signIn(page)
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('navigation')).toBeVisible()

  await page.goto('/settings')
  await expect(page.getByText('Family & People', { exact: true })).toBeVisible()
})
