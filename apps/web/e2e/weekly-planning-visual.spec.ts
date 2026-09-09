import { expect, test, type Page } from '@playwright/test'

// Visual verification for the session shell — the frame, not the data. The session is a
// three-row grid inside `.kiosk-main`; sized to `100dvh` it overflows by the topbar's height
// and pushes the footer off screen with every unit test still green.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: ['chore.manage', 'goal.manage'],
}

const modules = {
  pantry: false, chores: false, goals: false, meals: false,
  lists: false, familyNight: false, quotes: false, rhythms: false, weeklyPlanning: true,
}

const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'sunday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const capabilities = ['chore.manage', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((c) => [c, false]))

const step = (
  key: string, number: number, title: string, act: string,
  extra: Record<string, unknown> = {}
) => ({
  key, number, title, act, ask: `${title} — the one question?`, primary: 'Looks right',
  available: true, status: 'pending', data: {}, decidedAt: null, parked: [], ...extra,
})

const steps = [
  step('looseEnds', 1, 'Loose ends', 'Intake'),
  step('calendar', 2, 'Calendar', 'Frame the week'),
  step('horizon', 3, 'Horizon scan', 'Frame the week'),
  step('familyNight', 4, 'Family night', 'Claim the good', { available: false, requiresModule: 'familyNight' }),
  step('connection', 5, 'Connection', 'Claim the good'),
  step('goals', 6, 'Goals', 'Claim the good', { available: false, requiresModule: 'goals' }),
  step('meals', 7, 'Meals', 'Run the household', { available: false, requiresModule: 'meals' }),
  step('tasks', 8, 'Tasks', 'Run the household', { available: false, requiresModule: 'chores' }),
  step('kids', 9, 'Kids', 'Run the household'),
  step('recap', 10, 'Recap', 'Close', { primary: 'Save the week' }),
]

const session = {
  id: 'sess-1', weekStart: '2026-09-06', status: 'active', currentStep: 'calendar',
  driverPersonId: person.id, startedAt: '2026-09-06T17:00:00.000Z', completedAt: null,
}

const planningView = {
  config: { dayOfWeek: 0, time: '17:00', steps: {}, showOnToday: true },
  weekStart: '2026-09-06',
  defaultWeekStart: '2026-09-06',
  minWeekStart: '2026-08-30',
  session,
  steps,
}

const empty = {
  balances: [], chores: [], countdowns: [], currencies: [], entries: [], events: [],
  goals: [], groups: [], instances: [], items: [], lists: [], meals: [], members: [],
  people: [], persons: [], photos: [], recipes: [], rewards: [], suggestions: [],
}

async function mockApi(page: Page, view: unknown = planningView) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = empty

    if (path === '/api/auth/status') body = { initialized: true, methods: ['password'] }
    else if (path === '/api/auth/login') body = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 }
    else if (path === '/api/household') body = { provisioned: true, household, person, memberships: [], pendingInvites: [] }
    else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = { permissions: { adult: permissionRow, teen: permissionRow, kid: permissionRow }, capabilities, roles: ['adult', 'teen', 'kid'] }
    else if (path === '/api/weather') body = { weather: null }
    else if (path === '/api/updates') body = { enabled: false, updateAvailable: false }
    else if (path === '/api/calendar/status') body = { connected: false, configured: false }
    else if (path === '/api/weekly-planning') body = view
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

// Fully inside the viewport? The footer being in the DOM is not the claim.
async function withinViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.height > 0
  }, selector)
}

test('the session footer stays on screen on the board', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto('/planning')
  // Scope to the session's own title — "Calendar" is also a rail destination, so an
  // unscoped getByText passes on the rail while the screen is still an empty Suspense.
  await expect(page.locator('.wp-title')).toHaveText('Calendar')
  await page.screenshot({ path: 'test-results/weekly-planning-session.png' })

  expect(await withinViewport(page, '.wp-foot')).toBe(true)
  await expect(page.locator('.wp-primary')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Skip this step' })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the counter counts only the steps this household runs', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto('/planning')
  await expect(page.locator('.wp-stepchip')).toContainText('2 of 6')
  await expect(page.locator('.wp-prog > div')).toHaveAttribute('style', /width:\s*33%/)
})

test('the agenda sheet opens from the counter and lists only runnable steps', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto('/planning')
  await expect(page.locator('.wp-title')).toHaveText('Calendar')

  await expect(page.getByText('Intake')).toHaveCount(0)
  await page.locator('.wp-stepchip').click()
  await expect(page.getByText('Intake')).toBeVisible()
  await expect(page.getByText("you're here")).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-agenda.png' })

  await expect(page.getByRole('button', { name: /Family night/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Loose ends/ })).toBeVisible()
})

test('the phone gets the same screen, with the footer reachable', async ({ page }) => {
  await mockApi(page)
  // Sign in at the default size: the nav collapses below the phone breakpoint and the shared
  // helper waits on it, so the narrowing comes after.
  await signIn(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await expect(page.locator('.wp-title')).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-phone.png' })

  expect(await withinViewport(page, '.wp-foot')).toBe(true)
  // The primary must stay on one line. Measured as a height ceiling, because computed
  // line-height here is "normal" (parseFloat → NaN), not a number.
  const primaryHeight = await page.evaluate(() => {
    const el = document.querySelector('.wp-primary')
    return el ? Math.round(el.getBoundingClientRect().height) : 999
  })
  expect(primaryHeight).toBeLessThanOrEqual(56)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the agenda sheet fits a phone instead of clipping its own text', async ({ page }) => {
  // An explicit `width: 520px` sized `.modal-overlay`'s implicit grid column to match, so
  // `max-width: 100%` resolved to 520px and the card overhung a phone screen.
  await mockApi(page)
  await signIn(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await page.locator('.wp-stepchip').click()
  await expect(page.getByText('Intake')).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-sheet-phone.png' })

  const fit = await page.evaluate(() => {
    const el = document.querySelector('.wp-sheet') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { right: Math.round(r.right), left: Math.round(r.left), vw: window.innerWidth, clipped: el.scrollWidth - el.clientWidth }
  })
  expect(fit).not.toBeNull()
  expect(fit!.left).toBeGreaterThanOrEqual(0)
  expect(fit!.right).toBeLessThanOrEqual(fit!.vw)
  expect(fit!.clipped).toBeLessThanOrEqual(0)
})

test('a finished session reads back as a record', async ({ page }) => {
  await mockApi(page, {
    ...planningView,
    session: { ...session, status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' },
    steps: steps.map((s) => (s.key === 'looseEnds' ? { ...s, status: 'done' } : s.key === 'calendar' ? { ...s, status: 'skipped' } : s)),
  })
  await signIn(page)
  await page.goto('/planning')
  await expect(page.getByText('The week is decided')).toBeVisible()
  await expect(page.getByText('Skipped — a real answer')).toBeVisible()
  await expect(page.getByRole('button', { name: /Reopen the session/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-record.png' })
})

// ── The validation pass ────────────────────────────────────────────────────────

const handoffView = {
  ...planningView,
  steps: steps.map((st) =>
    st.key === 'calendar'
      ? step('calendar', 2, 'Calendar', 'Frame the week', {
          parked: [
            { id: 'pk1', note: 'book the campsite before it fills up', byline: 'Alex · 2 weeks ago' },
            { id: 'pk2', note: 'ask about the field trip form', byline: 'Alex · yesterday' },
          ],
        })
      : st
  ),
}

test('the month’s event chips keep their own height on a busy day', async ({ page }) => {
  // `.cal-cell` is a flex COLUMN, so its children shrink by default and jsdom cannot see it.
  await mockApi(page)
  // Five things on one day: more than the three the cell draws, so the row is at full pressure.
  const day = '2026-09-09'
  await page.route('**/api/events**', async (route) => {
    const events = [
      'Piano lesson', 'Little League', 'Temple Visit', 'Trip to the coast', 'Kramerica',
    ].map((title, i) => ({
      id: `e${i}`, title, startsAt: `${day}T${15 + i}:00:00.000Z`, endsAt: `${day}T${16 + i}:00:00.000Z`,
      allDay: false, personId: null, personColor: null, participants: [], rrule: null,
      occurrenceStart: null, rhythmId: null, goalId: null, location: null, notes: null,
    }))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events }) })
  })

  await signIn(page)
  await page.goto('/planning/horizon')
  await expect(page.locator('.wp-title')).toHaveText('Horizon scan')
  await expect(page.locator('.wph-cal .cal-cell').first()).toBeVisible()

  await page.screenshot({ path: 'test-results/weekly-planning-horizon-month.png' })

  // Every chip drawn is at least its own content's height. 18px is below the ~20px a
  // chip costs unsqueezed and well above the ~12px the compressed ones were rendering at.
  const heights = await page.locator('.wph-cal .ev').evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height)
  )
  expect(heights.length).toBeGreaterThan(0)
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(18)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the parked board stays on screen, and a chosen tag stays readable under the cursor', async ({ page }) => {
  // THE BOARD: height comes back by drawing one chip FEWER per day, never a smaller chip.
  // THE TAG: `:hover:not(:disabled)` (0,3,0) outscores `.on` (0,2,0), so the hover rule
  // repainted the chosen chip's text to `--ink` on `--ink`.
  await mockApi(page)
  await page.route('**/api/weekly-planning/horizon**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tags: [
          { stepKey: 'tasks', label: 'Tasks', hint: 'Someone owns it this week', primary: true },
          { stepKey: 'meals', label: 'Meals', hint: 'It changes what we eat' },
          { stepKey: 'kids', label: 'Kids', hint: "It's about one of the kids" },
        ],
        parked: [
          { id: 'pk1', note: 'we are going camping', stepKey: 'tasks', stepLabel: 'Tasks', createdAt: '2026-09-01T10:00:00.000Z' },
          { id: 'pk2', note: 'school photos', stepKey: null, stepLabel: null, createdAt: '2026-09-01T10:01:00.000Z' },
        ],
      }),
    })
  })

  await signIn(page)
  await page.goto('/planning/horizon')
  await expect(page.locator('.wp-title')).toHaveText('Horizon scan')

  const board = page.locator('.wph-board')
  await expect(board).toBeVisible()

  // ON A KIOSK the month gets all six rows AND the board keeps its place: `.wph-cal` is
  // `flex: 1`, taking whatever the bar, note and board leave.
  await page.setViewportSize({ width: 1280, height: 1000 })
  await expect(board).toBeVisible()
  expect(await withinViewport(page, '.wph-board')).toBe(true)
  await page.screenshot({ path: 'test-results/weekly-planning-horizon-board.png' })

  const grid = await page.evaluate(() => {
    const el = document.querySelector('.wph-cal .cal-grid') as HTMLElement | null
    const cells = document.querySelectorAll('.wph-cal .cal-cell').length
    return el ? { scrollH: el.scrollHeight, clientH: el.clientHeight, cells } : null
  })
  expect(grid).not.toBeNull()
  expect(grid!.cells).toBe(42)
  // The month USES the room it is given: six unsquashed rows cost ~552px and there are 491.
  expect(grid!.clientH).toBeGreaterThanOrEqual(92 * 5)

  // ON A SHORT SCREEN the month gives way instead of the board, and never compresses.
  await page.setViewportSize({ width: 1280, height: 720 })
  expect(await withinViewport(page, '.wph-board')).toBe(true)
  const heights = await page.locator('.wph-cal .ev').evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height)
  )
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(18)

  await page.setViewportSize({ width: 1280, height: 1000 })

  await page.getByLabel('Park a note').fill('test')
  const chosen = page.locator('.wph-tag.on')
  await expect(chosen).toHaveText('Tasks')

  const readable = async () =>
    chosen.evaluate((el) => {
      const cs = getComputedStyle(el)
      // Both as "r, g, b" — a chip whose text matches its own fill says nothing at all.
      return { color: cs.color, background: cs.backgroundColor }
    })

  const before = await readable()
  expect(before.color).not.toBe(before.background)

  await chosen.hover()
  const after = await readable()
  expect(after.color).not.toBe(after.background)
  expect(after.color).toBe(before.color)
  expect(after.background).toBe(before.background)
})

test('a parked note is handed to its step, above the body and on screen', async ({ page }) => {
  await mockApi(page, handoffView)
  await signIn(page)
  await page.goto('/planning')
  await expect(page.locator('.wp-title')).toHaveText('Calendar')

  const banner = page.locator('.wp-handoff')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('book the campsite before it fills up')
  await expect(banner).toContainText('Alex · 2 weeks ago')
  await page.screenshot({ path: 'test-results/weekly-planning-handoff.png' })

  // It must not cost the footer its place — the banner is a sibling of the step body in
  // `.wp-body`, and anything there that isn't `flex: none` competes for height.
  expect(await withinViewport(page, '.wp-foot')).toBe(true)

  await expect(banner.getByRole('button', { name: 'Make an event' }).first()).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Already handled' }).first()).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the handoff stacks its two answers under the note on a phone', async ({ page }) => {
  // Sign in at board size FIRST: `signIn` waits on the nav rail, which the phone layout
  // hides, so resizing first makes the helper wait for something that never appears.
  await mockApi(page, handoffView)
  await signIn(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await expect(page.locator('.wp-handoff')).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-handoff-phone.png' })

  const row = page.locator('.wp-handoff-row').first()
  expect((await row.boundingBox())!.height).toBeGreaterThan(60)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
