import { expect, test, type Page } from '@playwright/test'

// The month view's only way to add an event on a day that already has one.
//
// The grid cells select a day; they don't create. Creating lives in the right-hand day
// panel, which offers two paths — a "＋" in its header, and a tap-to-add empty state.
// The empty state only renders when the day has NO events, so on any day that already
// has one the "＋" is the sole route to the event modal. That makes its visibility
// load-bearing rather than cosmetic, which is what this file guards.
//
// Note on the assertion: `toBeVisible()` would NOT have caught the bug this test was
// written for. Playwright counts an element with `opacity: 0` as visible (it has a box
// and isn't `visibility: hidden`), and `click()` doesn't check opacity either — so both
// pass happily against a button no human can see. The computed opacity IS the bug, so
// that is what gets asserted.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: ['chore.manage', 'goal.manage'],
}

const modules = {
  pantry: false, chores: false, goals: false, meals: false,
  lists: false, familyNight: false, quotes: false, rhythms: false,
}

const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'sunday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const capabilities = ['chore.manage', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((c) => [c, false]))

// Dated into the month the calendar opens on (it defaults to today), on the 15th so it
// never collides with the "today" cell — the panel starts on today, and the day this
// test cares about has to be one it navigates TO.
const today = new Date()
const day = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 15, 15, 0, 0))
const dayEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 15, 16, 0, 0))
const dayKey = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-15`

const dentist = {
  id: 'ev-1', title: 'Dentist', description: null, location: null,
  startsAt: day.toISOString(), endsAt: dayEnd.toISOString(), allDay: false,
  timezone: 'America/Denver', personId: null, personName: null, personColor: null,
  goalId: null, goalStepId: null, rhythmId: null, isCountdown: false,
  rrule: null, occurrenceStart: null,
  calendarId: null, visibility: 'family', ownerPersonId: null, participants: [], status: 'confirmed',
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
    else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = { permissions: { adult: permissionRow, teen: permissionRow, kid: permissionRow }, capabilities, roles: ['adult', 'teen', 'kid'] }
    else if (path === '/api/weather') body = { weather: null }
    else if (path === '/api/updates') body = { enabled: false, updateAvailable: false }
    else if (path === '/api/calendar/status') body = { connected: false, configured: false }
    else if (path === '/api/events') body = { events: [dentist] }
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

test('the month view can add an event on a day that already has one', async ({ page }) => {
  await signIn(page)
  await page.goto('/calendar')

  // Select the 15th — the day carrying the mocked event.
  await page.locator(`.cal-cell`, { hasText: 'Dentist' }).click()

  const panel = page.locator('.cal-day-panel')
  await expect(panel.getByText('Dentist')).toBeVisible()
  // The precondition that makes the ＋ the only route: this day is not empty, so the
  // tap-to-add empty state is absent.
  await expect(panel.locator('.cal-day-empty')).toHaveCount(0)

  const add = panel.getByRole('button', { name: 'Add an event on this day' })
  await expect(add).toBeVisible()

  // The actual guard — a transparent button is not an affordance.
  const opacity = await add.evaluate((el) => Number(getComputedStyle(el).opacity))
  expect(opacity).toBeGreaterThan(0.9)

  await page.screenshot({ path: 'test-results/calendar-month-add.png', fullPage: true })

  // And it has to reach the editor, on the day that was selected.
  await add.click()
  const card = page.locator('.modal-card')
  await expect(card).toBeVisible()
  await expect(card.locator(`input[type="date"]`).first()).toHaveValue(dayKey)
})
