import { expect, test, type Page } from '@playwright/test'

// Visual verification for this batch's three web surfaces. Unit tests prove the
// data is right; these prove the UI doesn't *look* broken — specifically the Share
// list dialog, which now carries a third button in a wrapping row inside a 560px
// card, and the two new cards/rails.
//
// Screenshots land in test-results/ for eyeballing; the assertions are the guard.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: ['chore.manage', 'goal.manage'],
}

const modules = {
  pantry: false, chores: false, goals: false, meals: true,
  lists: true, familyNight: false, quotes: false,
}

const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'sunday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const capabilities = ['chore.manage', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((c) => [c, false]))

const lists = [
  { id: 'l1', name: 'Hardware store', emoji: '🔧', listType: 'custom', isAutoBuilt: false, sortMode: 'manual', itemCount: 3 },
  { id: 'l2', name: 'Packing', emoji: '🧳', listType: 'custom', isAutoBuilt: false, sortMode: 'manual', itemCount: 2 },
]

const listItems = [
  { id: 'i1', name: 'Wood screws', quantity: '1 box', checked: false, section: 'Hardware', aisle: 'Hardware', store: null, priority: null, assignee: null },
  { id: 'i2', name: 'Sandpaper', quantity: null, checked: false, section: 'Hardware', aisle: 'Hardware', store: null, priority: null, assignee: null },
  { id: 'i3', name: 'Wood glue', quantity: null, checked: false, section: null, aisle: null, store: null, priority: null, assignee: null },
]

const recipe = (id: string, title: string) => ({
  id, title, emoji: '🍝', description: null, category: 'dinner', tags: null,
  prepTimeMinutes: 10, cookTimeMinutes: 25, servings: 4, imageUrl: null, storageKey: null,
  sourceName: null, isFavorite: false, cookedCount: 2, lastCookedAt: null, mealType: null,
  protein: null, base: null, cuisine: null, effort: null, cookMethod: null, flavorProfile: null,
  dietary: [], vegetables: [], collection: null,
})

const recipes = [recipe('r1', 'Weeknight Bolognese'), recipe('r2', 'Sheet-pan Salmon'), recipe('r3', 'Green Curry')]

const empty = {
  balances: [], chores: [], countdowns: [], currencies: [], entries: [], events: [],
  goals: [], groups: [], instances: [], items: [], lists: [], meals: [], members: [],
  people: [], persons: [], photos: [], recipes: [], rewards: [], suggestions: [],
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let body: unknown = empty

    if (path === '/api/auth/status') body = { initialized: true, methods: ['password'] }
    else if (path === '/api/auth/login') body = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 }
    else if (path === '/api/household') body = { provisioned: true, household, person, memberships: [], pendingInvites: [] }
    else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = { permissions: { adult: permissionRow, teen: permissionRow, kid: permissionRow }, capabilities, roles: ['adult', 'teen', 'kid'] }
    else if (path === '/api/weather') body = { weather: null }
    else if (path === '/api/updates') body = { enabled: false, updateAvailable: false }
    else if (path === '/api/calendar/status') body = { connected: false, configured: false }
    else if (path === '/api/lists') body = { lists }
    // These two first — the generic list-detail pattern below would swallow them.
    else if (path === '/api/lists/grocery') body = { items: listItems }
    else if (path === '/api/lists/templates') body = { templates: [] }
    else if (/^\/api\/lists\/[^/]+$/.test(path)) body = { list: lists[0], items: listItems }
    else if (path === '/api/recipes/recent') body = { recipes, scope: url.searchParams.get('scope') ?? 'me' }
    else if (path === '/api/recipes') body = { recipes }
    else if (path === '/api/powersync/token') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'disabled' }) })
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

test.beforeEach(async ({ page }) => {
  await mockApi(page)
})

test('the Share list dialog fits its three actions on one row', async ({ page }) => {
  // Desktop Chromium has no navigator.share, so the modal would render only TWO
  // buttons and the three-in-a-row case — the one that can wrap badly — would go
  // untested. Stub it so all three render.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: async () => {}, configurable: true })
  })
  await signIn(page)
  await page.goto('/lists')
  // Share lives behind the selected list's ⋯ menu, and only while something is
  // still unchecked.
  await page.getByText('Hardware store').first().click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: /Share list/i }).click()

  const card = page.locator('.modal-card')
  await expect(card).toBeVisible()
  const share = page.getByRole('button', { name: 'Copy as Markdown' })
  await expect(share).toBeVisible()
  await page.screenshot({ path: 'test-results/share-list-markdown.png', fullPage: false })

  // All three actions must sit on ONE row inside the 560px card — a wrapped third
  // button is the regression this test exists to catch.
  const boxes = await Promise.all(
    ['Share…', 'Copy list', 'Copy as Markdown'].map((name) =>
      page.getByRole('button', { name }).boundingBox()
    )
  )
  for (const b of boxes) expect(b).not.toBeNull()
  const ys = boxes.map((b) => b!.y)
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4)
})

test('the Today board renders the pinned Lists card', async ({ page }) => {
  await signIn(page)
  await page.goto('/')
  const card = page.getByText('Hardware store').first()
  await expect(card).toBeVisible()
  await page.screenshot({ path: 'test-results/today-lists-card.png', fullPage: false })
})

test('the recipe library renders the recently-viewed rail', async ({ page }) => {
  await signIn(page)
  await page.goto('/meals/recipes')
  const rail = page.getByTestId('recent-recipes')
  await expect(rail).toBeVisible()
  await expect(rail.getByText('Weeknight Bolognese')).toBeVisible()
  await page.screenshot({ path: 'test-results/recipes-recent-rail.png', fullPage: false })
})
