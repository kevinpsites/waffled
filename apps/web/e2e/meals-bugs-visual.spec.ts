import { expect, test, type Page } from '@playwright/test'

// Visual verification for this batch's web surfaces. The unit tests prove the data and
// the wiring; these prove the UI doesn't *look* broken — the editor now renders inside a
// modal over the picker (a screen that used to own the whole page), the cook-mode
// ingredients became controls, and the planner grid is cut on the household's own day.
//
// Screenshots land in test-results/ for eyeballing; the assertions are the guard.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: ['goal.manage'],
}

const modules = {
  pantry: false, chores: false, goals: false, meals: true,
  lists: false, familyNight: false, quotes: false,
}

// A MONDAY household — the setting whose whole point is that the planner follows it.
const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'monday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const capabilities = ['goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((c) => [c, false]))

const recipe = (id: string, title: string) => ({
  id, title, emoji: '🍝', description: null, category: 'dinner', tags: null,
  prepTimeMinutes: 10, cookTimeMinutes: 25, servings: 4, imageUrl: null, storageKey: null,
  sourceName: null, isFavorite: false, cookedCount: 2, lastCookedAt: null, mealType: null,
  protein: null, base: null, cuisine: null, effort: null, cookMethod: null, flavorProfile: null,
  dietary: [], vegetables: [], collection: null,
})

const recipes = [recipe('r1', 'Weeknight Bolognese'), recipe('r2', 'Sheet-pan Salmon')]

const ing = (id: string, name: string, amount: number | null, unit: string | null) => ({
  id, name, amount, unit, prepNote: null, display: null, section: null, aisle: null,
  isStaple: false, sortOrder: null, sub: null,
})

const detail = {
  recipe: { ...recipe('r1', 'Weeknight Bolognese'), notes: null, userNotes: null, addedTags: [], overrides: {} },
  ingredients: [
    ing('i1', 'onion', 1, null),
    ing('i2', 'garlic', 4, 'cloves'),
    ing('i3', 'ground beef', 1, 'lb'),
    ing('i4', 'crushed tomatoes', 28, 'oz'),
  ],
  steps: [
    { stepNumber: 1, instruction: 'Soften the onion and garlic in oil.', ingredients: ['1 onion', '4 cloves garlic'], note: null, timerSeconds: null },
    { stepNumber: 2, instruction: 'Brown the beef, then add the tomatoes and simmer.', ingredients: ['1 lb ground beef', '28 oz crushed tomatoes'], note: null, timerSeconds: 1800 },
  ],
  onHand: null, toBuy: 0, toBuyNames: [],
}

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
    else if (path === '/api/recipes/sections') body = { sections: [] }
    else if (path === '/api/recipes/ingest/config') body = { text: false, vision: false }
    else if (path === '/api/recipes/recent') body = { recipes, scope: url.searchParams.get('scope') ?? 'me' }
    else if (path === '/api/recipes/r1') body = detail
    else if (path === '/api/recipes') body = { recipes }
    else if (path === '/api/meals/week') body = { start: '', entries: [] }
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

test('the meal-slot picker opens a full recipe editor over itself', async ({ page }) => {
  await signIn(page)
  await page.goto('/meals')

  // Open a slot's picker, then write a recipe without leaving it.
  // Wait for the grid itself — the Today capture bar also has an "Add anything…"
  // button, and it is on screen first.
  const grid = page.locator('.meals-grid')
  await expect(grid).toBeVisible()
  await grid.getByRole('button', { name: /^Add / }).first().click()

  const newBtn = page.getByRole('button', { name: /New recipe/i })
  await expect(newBtn).toBeVisible()
  await newBtn.click()

  const card = page.locator('.modal-card.picker-new-card')
  await expect(card).toBeVisible()
  await expect(page.getByPlaceholder('Recipe title')).toBeVisible()
  await page.screenshot({ path: 'test-results/picker-new-recipe.png', fullPage: false })

  // The editor must sit INSIDE the card, not overflow the viewport — it was built as
  // a full page and is being hosted in a modal for the first time.
  const box = (await card.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.height).toBeLessThanOrEqual(viewport.height)
  // Its own Create/Cancel actions are reachable by scrolling the card, not lost.
  await expect(page.getByRole('button', { name: 'Create recipe' })).toBeAttached()

  // Cancelling returns to the picker rather than navigating away — the picker's own
  // search and its "New recipe" button are both still there.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(card).toBeHidden()
  await expect(page.getByPlaceholder(/Search recipes/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /New recipe/i })).toBeVisible()
})

test('cook mode renders its ingredients as things you can tick off', async ({ page }) => {
  await signIn(page)
  await page.goto('/meals/recipe/r1/cook')

  const chip = page.getByRole('checkbox', { name: '1 onion' })
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('aria-checked', 'false')
  await chip.click()
  await expect(chip).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: 'test-results/cookmode-step-ticked.png', fullPage: false })

  // The full list agrees, and counts what's gathered.
  await page.getByRole('button', { name: 'All ingredients' }).click()
  const list = page.locator('.modal-card')
  await expect(list).toBeVisible()
  const count = list.getByText('1 of 4')
  await expect(count).toBeVisible()
  // The modal's × is absolutely positioned in that corner; the count must not run
  // under it (it did — the tail of "1 of 4" was hidden behind the button).
  const countBox = (await count.boundingBox())!
  const closeBox = (await list.getByRole('button', { name: 'Close' }).boundingBox())!
  expect(countBox.x + countBox.width).toBeLessThanOrEqual(closeBox.x)
  await expect(list.getByRole('checkbox', { name: /onion/ })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: 'test-results/cookmode-all-ingredients.png', fullPage: false })

  // Rows are real rows, not a stack of collapsed buttons.
  const row = list.getByRole('checkbox', { name: /crushed tomatoes/ })
  const rowBox = (await row.boundingBox())!
  expect(rowBox.height).toBeGreaterThan(20)
  expect(rowBox.width).toBeGreaterThan(200)
})

test('a monday household gets a Monday-led planner grid', async ({ page }) => {
  await signIn(page)
  await page.goto('/meals')

  const dows = page.locator('.meals-dow .dow')
  await expect(dows.first()).toHaveText('Mon')
  expect(await dows.allTextContents()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  await page.screenshot({ path: 'test-results/meals-week-monday.png', fullPage: false })

  await page.getByRole('button', { name: 'Month' }).click()
  const mdows = page.locator('.mm-dow')
  await expect(mdows.first()).toHaveText('Mon')
  expect(await mdows.allTextContents()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  await page.screenshot({ path: 'test-results/meals-month-monday.png', fullPage: false })
})
