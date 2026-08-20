import { expect, test, type Page } from '@playwright/test'

// Visual verification for the rhythms surfaces. The unit tests prove the data and the
// copy are right; these prove the layout doesn't break. Each case here was flagged by the
// worker who built it as something a unit test structurally cannot catch:
//
//  1. A recurring rhythm renders TWO glyphs before its title (↻ from the recurrence, 🔁
//     from the rhythm) inside a nowrap, ellipsised 12.5px slot. That's the ordinary shape
//     for trash-night and third-Saturday rhythms, not an edge case.
//  2. The register's action row now carries up to five controls and has to survive the
//     300px grid minimum.
//  3. The editor's anchor block — the explanation standing in for the fields we refuse
//     to make editable.
//
// Screenshots land in test-results/ for eyeballing; the assertions are the guard.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: ['chore.manage', 'goal.manage'],
}

const modules = {
  pantry: false, chores: false, goals: false, meals: false,
  lists: false, familyNight: false, quotes: false, rhythms: true,
}

const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'sunday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const capabilities = ['chore.manage', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((c) => [c, false]))

// A booking-shape rhythm mid-runway, an auto-scheduled one, and a completion one — the
// three states the register has to lay out side by side.
const templeVisit = {
  id: 'rh-1', title: 'Temple visit', emoji: '🕊️', notes: null, personId: person.id,
  satisfiedBy: 'scheduling', every: '3 mons', startsOn: '2026-07-01', autoSchedule: false,
  rrule: null, leadTime: '14 days', lastCompletedAt: null, nextDueAt: null, isActive: true,
  currentPeriodStart: '2026-07-01', currentPeriodEnd: '2026-10-01', satisfied: false,
}

const outing = {
  id: 'rh-2', title: 'Third-weekend family outing', emoji: '🎡', notes: null, personId: null,
  satisfiedBy: 'scheduling', every: '1 mon', startsOn: '2026-09-01', autoSchedule: true,
  rrule: 'FREQ=MONTHLY;BYDAY=3SA', leadTime: '14 days', lastCompletedAt: null, nextDueAt: null,
  isActive: true, currentPeriodStart: '2026-09-01', currentPeriodEnd: '2026-10-01', satisfied: true,
}

const airFilter = {
  id: 'rh-3', title: 'Air filter', emoji: '🌬️', notes: 'under the stairs', personId: null,
  satisfiedBy: 'completion', every: '3 mons', startsOn: null, autoSchedule: false, rrule: null,
  leadTime: '14 days', lastCompletedAt: '2026-06-15T12:00:00.000Z',
  nextDueAt: '2026-09-15T12:00:00.000Z', isActive: true,
  currentPeriodStart: null, currentPeriodEnd: null, satisfied: true,
}

const paused = {
  ...airFilter, id: 'rh-4', title: 'Summer-only pool check', emoji: '🏊', isActive: false,
}

const rhythms = [templeVisit, outing, airFilter, paused]

const attention = {
  items: [
    { kind: 'unscheduled', rhythm: templeVisit, periodStart: '2026-07-01', periodEnd: '2026-10-01' },
    { kind: 'due', rhythm: airFilter, dueAt: '2026-09-15T12:00:00.000Z', overdue: false },
  ],
}

// A recurring event that also keeps a rhythm — the two-glyph case. Dated inside the
// month the calendar opens on, since it defaults to today and a fixed date would drift
// out of view the moment the real clock moved past it.
const today = new Date()
const inView = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 15, 15, 0, 0))
const inViewEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 15, 18, 0, 0))

const recurringOuting = {
  id: 'ev-1', title: 'Third-weekend family outing', description: null, location: null,
  startsAt: inView.toISOString(), endsAt: inViewEnd.toISOString(), allDay: false,
  timezone: 'America/Denver', personId: null, personName: null, personColor: null,
  goalId: null, goalStepId: null, rhythmId: 'rh-2', isCountdown: false,
  rrule: 'FREQ=MONTHLY;BYDAY=3SA', occurrenceStart: inView.toISOString(),
  calendarId: null, visibility: 'family', ownerPersonId: null, participants: [], status: 'confirmed',
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
    else if (path === '/api/rhythms/attention') body = attention
    else if (path === '/api/rhythms') body = { rhythms }
    else if (path === '/api/events') body = { events: [recurringOuting] }
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

test('the register lays out its rows without overflowing', async ({ page }) => {
  await signIn(page)
  await page.goto('/rhythms')
  await expect(page.getByText('Temple visit')).toBeVisible()
  await page.screenshot({ path: 'test-results/rhythms-register.png', fullPage: true })

  // Nothing may spill sideways — the action row grew to as many as five controls.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the register survives the narrow grid minimum', async ({ page }) => {
  // Sign in at the default size — the nav collapses below the phone breakpoint and the
  // shared sign-in helper waits on it. The narrowing is what this test is about, so it
  // happens after.
  await signIn(page)
  await page.setViewportSize({ width: 380, height: 900 })
  await page.goto('/rhythms')
  await expect(page.getByText('Temple visit')).toBeVisible()
  await page.screenshot({ path: 'test-results/rhythms-register-narrow.png', fullPage: true })

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the paused rhythm reads as paused and offers no period actions', async ({ page }) => {
  await signIn(page)
  await page.goto('/rhythms')
  const row = page.locator('.rhy-item', { hasText: 'Summer-only pool check' })
  await expect(row).toBeVisible()
  await expect(row.locator('.rhy-badge.off')).toHaveText(/paused/i)
  // Booking a paused rhythm would actually work server-side, which is exactly why the
  // control must not be here. Same for skip.
  await expect(row.getByRole('button', { name: /^Book a time$/ })).toHaveCount(0)
  await expect(row.getByRole('button', { name: /^Skip this period for/ })).toHaveCount(0)
  // Resume must be reachable, or pausing is a one-way trip.
  await expect(row.getByRole('button', { name: /^Resume / })).toBeVisible()
})

test('the backdate row fits the register at the narrow grid minimum', async ({ page }) => {
  // The completion row's action strip gained a fifth control ("Log it for another day")
  // and can now open a date field beneath it. Both are the sort of thing that lays out
  // fine at desktop width and falls apart at the 300px grid minimum.
  await signIn(page)
  await page.setViewportSize({ width: 380, height: 900 })
  await page.goto('/rhythms')
  const row = page.locator('.rhy-item', { hasText: 'Air filter' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: /log it for another day/i }).click()

  await expect(row.locator('.rhy-backdate')).toBeVisible()
  await expect(row.getByRole('button', { name: /^Log it$/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/rhythms-backdate-narrow.png', fullPage: true })

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the editor picks a repeat day with chips rather than an RRULE box', async ({ page }) => {
  await signIn(page)
  await page.goto('/rhythms')
  await page.getByRole('button', { name: 'New rhythm' }).click()
  const card = page.locator('.modal-card')
  await card.getByRole('button', { name: /it gets scheduled/i }).click()
  await card.getByLabel('Put it on the calendar automatically').click()

  // Seven day chips, rendered — not a text field asking for FREQ=…
  // `exact` matters: Playwright's accessible-name match is a substring by default, and
  // "WE" is inside "It gets scheduled Done when…" on the shape picker above.
  await expect(card.getByRole('button', { name: 'WE', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/rhythms-editor-repeat.png', fullPage: false })

  // The raw rule is still reachable, just not the first thing asked.
  await expect(card.getByText(/advanced \(raw rrule\)/i)).toBeVisible()

  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the editor explains the anchor instead of offering to move it', async ({ page }) => {
  await signIn(page)
  await page.goto('/rhythms')
  const row = page.locator('.rhy-item', { hasText: 'Temple visit' })
  await row.getByRole('button', { name: 'Edit Temple visit' }).click()

  const card = page.locator('.modal-card')
  await expect(card).toBeVisible()
  await page.screenshot({ path: 'test-results/rhythms-editor-anchor.png', fullPage: false })

  // The refusal has to be visible and explained, not silently absent.
  await expect(card.locator('.rhy-anchor')).toBeVisible()
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('a recurring rhythm event fits both its glyphs in the title slot', async ({ page }) => {
  await signIn(page)
  await page.goto('/calendar')
  await page.screenshot({ path: 'test-results/rhythms-calendar-glyphs.png', fullPage: true })

  // A month cell gives a chip ~100px. Rendering both "↻" and "🔁" left six characters of
  // the title readable ("↻ 🔁 Third-…") — and an auto-scheduled rhythm is always
  // recurring, so that is the ordinary case. The rhythm marker is the more specific fact,
  // so in the month grid it wins and the repeat arrow stands down.
  const chip = page.locator('.ev', { hasText: 'Third-weekend' }).first()
  await expect(chip).toBeVisible()
  await expect(chip.locator('.ev-rhythm')).toBeVisible()
  await expect(chip.locator('.ev-rep')).toHaveCount(0)

  // Enough of the title has to survive the glyph to identify the event.
  const shown = (await chip.innerText()).replace(/[🔁↻\s]/gu, '')
  expect(shown.length).toBeGreaterThan(6)
})

test('a recurring event that is NOT a rhythm keeps its repeat arrow', async ({ page }) => {
  // The other half of the rule: standing the arrow down is specific to rhythm-backed
  // events, not a blanket removal.
  await page.route('**/api/events*', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ events: [{ ...recurringOuting, id: 'ev-2', title: 'Standup', rhythmId: null }] }),
    })
  })
  await signIn(page)
  await page.goto('/calendar')
  const chip = page.locator('.ev', { hasText: 'Standup' }).first()
  await expect(chip).toBeVisible()
  await expect(chip.locator('.ev-rep')).toBeVisible()
  await expect(chip.locator('.ev-rhythm')).toHaveCount(0)
})
