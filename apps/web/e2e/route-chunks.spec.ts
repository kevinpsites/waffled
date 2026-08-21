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

const capabilities = ['chore.manage', 'chore.approve', 'reward.manage', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((capability) => [capability, false]))
const permissions = { adult: permissionRow, teen: permissionRow, kid: permissionRow }
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
    else if (path === '/api/auth/login') body = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 }
    else if (path === '/api/household') body = { provisioned: true, household, person, memberships: [], pendingInvites: [] }
    else if (path === '/api/household/settings') {
      body = {
        household,
        members: [{ ...person, hasLogin: true, loginEmail: 'alex@example.test', hasPassword: true, hasPin: false, isOwner: true }],
      }
    } else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = { permissions, capabilities, roles: ['adult', 'teen', 'kid'] }
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
const ROUTES = [
  '/',
  '/calendar',
  '/calendar/event/event-1',
  '/tasks',
  '/goals',
  '/goals/new',
  '/goals/goal-1',
  '/goals/goal-1/edit',
  '/family',
  '/person/person-1',
  '/person/person-1/waffled-bite',
  '/meals',
  '/meals/recipes',
  '/meals/build',
  '/meals/build/meal-1',
  '/meals/recipe/new',
  '/meals/recipe/recipe-1',
  '/meals/recipe/recipe-1/edit',
  '/meals/recipe/recipe-1/cook',
  '/meals/meal/meal-1/cook',
  '/lists',
  '/pantry',
  '/photos',
  '/settings',
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
    current = route
    await page.goto(route)
    // The shell is eager, so it renders even when a screen chunk dies — which is
    // exactly why its presence alone is not evidence the screen loaded.
    await expect(page.getByRole('navigation')).toBeVisible()
    // ScreenBoundary's fallback. If this is up, the screen threw rather than rendered.
    const errorCard = page.getByText("This screen couldn't load")
    if (await errorCard.isVisible().catch(() => false)) {
      problems.push(`${route}: rendered the ScreenBoundary error card`)
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
