import { expect, test, type Page } from '@playwright/test'

// Visual verification for the pantry ↔ grocery flags. The unit tests prove the data and
// the defaults are right; these prove the UI doesn't LOOK broken — a badge is a new chip
// squeezed into an already-busy grocery row (dots, store, quantity, two action buttons),
// which is exactly the kind of thing a green jsdom test can't judge.
//
// Screenshots land in test-results/ for eyeballing; the assertions are the guard.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: [],
}

// Pantry ON — the badge is gated on it.
const modules = {
  pantry: true, chores: false, goals: false, meals: true,
  lists: true, familyNight: false, quotes: false,
}

const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'sunday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const permissionRow = {}

const boardRow = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  quantity: null,
  quantityInput: null,
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 0,
  assignee: null,
  store: null,
  priority: null,
  aisle: 'Produce',
  source: 'auto',
  sourceRecipeIds: ['r1'],
  addedBy: null,
  weekStart: '2026-06-07',
  pantry: null,
  ...extra,
})

// The worst realistic case for the row layout: a badge alongside a store chip, a
// quantity, a meal dot and both action buttons — plus a long fuzzy-matched name.
const boardItems = [
  boardRow('Leeks', { quantity: '2' }),
  boardRow('Heavy cream', {
    quantity: '1 cup',
    pantry: { name: 'Heavy cream', amount: '2', unit: 'cups' },
  }),
  boardRow('Chicken', {
    quantity: '1½ lb',
    aisle: 'Meat & Seafood',
    store: 'Costco',
    pantry: { name: 'Boneless chicken breast', amount: '3', unit: 'packages' },
  }),
  boardRow('Rice', { aisle: 'Pantry', pantry: { name: 'Rice', amount: '', unit: '' } }),
  boardRow('Parmesan', { aisle: 'Dairy & Chilled', checked: true, pantry: { name: 'Parmesan', amount: '1', unit: 'wedge' } }),
]

const board = {
  list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: boardItems.length },
  weekStart: '2026-06-07',
  meals: [{ date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', mealId: null, title: 'Chicken & Leeks', emoji: '🍗', color: '#2F7FED', recipes: [] }],
  unscheduled: [],
  unscheduledMeals: [],
  items: boardItems,
  staples: [{ id: 's1', name: 'Olive oil' }, { id: 's2', name: 'Salt & pepper' }],
}

const recipe = {
  id: 'r1', title: 'Chicken & Leeks', emoji: '🍗', description: null, category: 'dinner', tags: null,
  prepTimeMinutes: 10, cookTimeMinutes: 25, servings: 4, imageUrl: null, storageKey: null,
  sourceName: null, isFavorite: false, cookedCount: 2, lastCookedAt: null, mealType: null,
  protein: null, base: null, cuisine: null, effort: null, cookMethod: null, flavorProfile: null,
  dietary: [], vegetables: [], collection: null, overrides: null, notes: null, rating: null,
  addedTags: [],
}

// Today renders before we navigate away, and it hard-crashes on a missing layout —
// so this needs a real shape even though no test looks at Today.
const todayLayout = {
  resolved: { cols: [[], [], []], hidden: [] },
  family: null,
  user: null,
  source: 'default',
  cards: [],
  canEditFamily: true,
}

const ingredient = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, amount: 1, unit: null, prepNote: null, display: null, section: null,
  aisle: null, isStaple: false, sortOrder: 0, sub: null, inPantry: false, ...extra,
})

// One of each case the picker has to distinguish, so the hint column can be eyeballed.
const ingredients = [
  ingredient('i1', 'Leeks', { amount: 2 }),
  ingredient('i2', 'Heavy cream', { amount: 1, unit: 'cup', inPantry: true }),
  ingredient('i3', 'Chicken thighs', { amount: 1.5, unit: 'lb', inPantry: true }),
  ingredient('i4', 'Olive oil', { amount: 2, unit: 'Tbsp', isStaple: true }),
  ingredient('i5', 'Rice', { amount: 1, unit: 'cup', isStaple: true, inPantry: true }),
]

const empty = {
  balances: [], chores: [], countdowns: [], currencies: [], entries: [], events: [],
  goals: [], groups: [], instances: [], items: [], lists: [], meals: [], members: [],
  people: [], persons: [], photos: [], recipes: [], rewards: [], suggestions: [],
}

export async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let body: unknown = empty

    if (path === '/api/auth/status') body = { initialized: true, methods: ['password'] }
    else if (path === '/api/auth/login') body = {
      accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900,
      memberType: 'adult', accessExpiresAt: null,
    }
    else if (path === '/api/household') body = { provisioned: true, household, person, memberships: [], pendingInvites: [] }
    else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = { permissions: { adult: permissionRow, teen: permissionRow, kid: permissionRow }, capabilities: [], roles: ['adult', 'teen', 'kid'] }
    else if (path === '/api/weather') body = { weather: null }
    else if (path === '/api/updates') body = { enabled: false, updateAvailable: false }
    else if (path === '/api/calendar/status') body = { connected: false, configured: false }
    else if (path === '/api/today-layout') body = todayLayout
    else if (path === '/api/lists/templates') body = { templates: [] }
    else if (path === '/api/lists') body = { lists: [board.list] }
    else if (path === '/api/lists/grocery/board') body = board
    else if (path === '/api/lists/grocery/rebuild') body = { rebuilt: board.items.length, board }
    else if (path === '/api/lists/grocery') body = { items: boardItems }
    else if (path === '/api/lists/stores') body = { stores: ['Costco'] }
    else if (path === '/api/pantry-staples') body = { staples: board.staples }
    else if (path === '/api/recipes/r1') body = { recipe, ingredients, steps: [], onHand: { have: 3, total: 5 }, toBuy: 2, toBuyNames: ['Leeks', 'Chicken thighs'] }
    else if (path === '/api/recipes') body = { recipes: [recipe] }
    else if (path === '/api/powersync/token') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'disabled' }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

export async function signIn(page: Page) {
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

test('the grocery board badges pantry rows without breaking the row layout', async ({ page }) => {
  await signIn(page)
  await page.goto('/lists')

  await expect(page.getByText('Leeks').first()).toBeVisible()
  // 4 rows carry a pantry hit, but the checked one lives in the collapsed "Completed"
  // tray, which renders a deliberately stripped row (name + quantity only — no meal
  // dots, no store chip, no actions). A badge there would be advice about a decision
  // you've already made, so 3 is correct. See the Completed assertion below.
  await expect(page.locator('.gpantry')).toHaveCount(3)
  await page.screenshot({ path: 'test-results/pantry-grocery-board.png', fullPage: false })

  // THE regression this test exists to catch, and one no jsdom test can see: the badge
  // must not steal width from the item name. As a trailing chip it did exactly that —
  // "Heavy cream" wrapped mid-phrase and the badge collided with the attribution line —
  // so the badge now lives inside the body column on its own line.
  const row = page.locator('.gitem', { hasText: 'Boneless chicken breast' }).first()
  const nameBox = await row.locator('.gnm').boundingBox()
  const badgeBox = await row.locator('.gpantry').boundingBox()
  expect(nameBox).not.toBeNull()
  expect(badgeBox).not.toBeNull()
  // A single unwrapped line of 16px text. Two lines would be ~40px.
  expect(nameBox!.height).toBeLessThan(26)
  // ...and the badge sits BELOW the name rather than beside it.
  expect(badgeBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 2)

  // Every other row keeps its name on one line too.
  for (const name of ['Leeks', 'Heavy cream', 'Rice']) {
    const b = await page.locator('.gitem', { hasText: name }).first().locator('.gnm').boundingBox()
    expect(b!.height, `${name} name wrapped`).toBeLessThan(26)
  }

  // And it must not push the action buttons off the row.
  await expect(row.getByTitle('Edit')).toBeVisible()
  await expect(row.getByTitle('Remove')).toBeVisible()

  // The badge is styled, not raw text — an unstyled chip means the CSS never loaded.
  const bg = await row.locator('.gpantry').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)')

  // The Completed tray stays badge-free by design (see above) — asserted so the
  // stripped-row decision is explicit rather than an accident of markup.
  await page.getByText('Completed').click()
  const done = page.locator('.grocery-done-list')
  await expect(done.getByText('Parmesan')).toBeVisible()
  await expect(done.locator('.gpantry')).toHaveCount(0)
})

test('the badge survives a narrow kiosk-portrait viewport', async ({ page }) => {
  // The row is dense; a 768-wide portrait tablet is the real squeeze.
  await page.setViewportSize({ width: 768, height: 1024 })
  await signIn(page)
  await page.goto('/lists')
  await expect(page.getByText('Leeks').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/pantry-grocery-board-narrow.png', fullPage: false })

  // Nothing may overflow the page horizontally.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('the recipe picker pre-unchecks pantry items and shows the right hints', async ({ page }) => {
  await signIn(page)
  await page.goto('/meals/recipe/r1')

  await expect(page.getByText('Chicken & Leeks').first()).toBeVisible()
  await page.getByRole('button', { name: /Add to grocery/i }).first().click()

  const card = page.locator('.modal-card')
  await expect(card).toBeVisible()
  // 5 ingredients, 3 in the pantry → 2 checked.
  await expect(page.getByRole('button', { name: /Add 2 items/ })).toBeVisible()
  await expect(page.getByText(/already unchecked 3 items your pantry says you have/)).toBeVisible()
  // The real match and the staple guess must be visually distinguishable.
  await expect(page.locator('.ring-inpantry')).toHaveCount(3)
  await expect(page.getByText('pantry staple — likely on hand')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/pantry-grocery-picker.png', fullPage: false })

  const color = await page.locator('.ring-inpantry').first().evaluate((el) => getComputedStyle(el).color)
  expect(color).not.toBe('rgb(0, 0, 0)')
})
