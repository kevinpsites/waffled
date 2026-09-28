import { expect, test, type Page } from '@playwright/test'

const person = {
  id: 'person-1',
  name: 'Alex',
  memberType: 'adult',
  isAdmin: true,
  avatarEmoji: 'A',
  colorHex: '#4f7f73',
  capabilities: ['chore.manage', 'chore.approve', 'goal.manage'],
}

const modules = {
  pantry: false,
  chores: false,
  goals: false,
  meals: false,
  lists: false,
  familyNight: false,
  quotes: false,
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

const capabilities = ['chore.manage', 'chore.approve', 'reward.manage', 'reward.approve', 'reward.grant', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((capability) => [capability, false]))
const permissions = { adult: permissionRow, teen: permissionRow, kid: permissionRow }
const empty = {
  balances: [],
  chores: [],
  countdowns: [],
  currencies: [],
  entries: [],
  events: [],
  goals: [],
  groups: [],
  instances: [],
  items: [],
  lists: [],
  meals: [],
  members: [],
  people: [],
  persons: [],
  photos: [],
  recipes: [],
  rewards: [],
  suggestions: [],
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = empty

    if (path === '/api/auth/status') body = { initialized: true, methods: ['password'] }
    else if (path === '/api/auth/login') body = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 }
    else if (path === '/api/auth/logout') body = { ok: true }
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

test.beforeEach(async ({ page }) => {
  await mockApi(page)
})

test('signs in and signs out through the rendered application', async ({ page }) => {
  await signIn(page)

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByText('Family & People', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('button', { name: 'Tap again to sign out' }).click()

  await expect(page.getByText('Welcome back')).toBeVisible()
  await expect(page.locator('input[type="email"]')).toHaveValue('')
})

test('never stores authenticated API responses in Cache Storage', async ({ page }) => {
  await signIn(page)

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const response = await page.evaluate(async () => {
    const result = await fetch('/api/household', { headers: { authorization: 'Bearer test-access' } })
    return { ok: result.ok, body: await result.json() }
  })
  expect(response.ok).toBe(true)
  expect(response.body).toMatchObject({ household: { id: household.id } })

  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      urls.push(...(await cache.keys()).map((request) => request.url))
    }
    return urls
  })
  expect(cachedUrls.filter((url) => new URL(url).pathname.startsWith('/api/'))).toEqual([])
})

// Exercise the shipped grid and detail components with real browser image errors.
// The route mocks stand in for an expired bearer URL and its authenticated parent read.
test('photo grid and detail recover expired media through the owning resource', async ({ page }, testInfo) => {
  const expires = Math.floor(Date.now() / 1000) + 600
  const staleURL = `/media/test-family/photo.png?expires=${expires}&sig=stale`
  const freshURL = `/media/test-family/photo.png?expires=${expires + 1}&sig=fresh`
  const photo = {
    id: 'photo-1', imageUrl: staleURL, caption: 'Media recovery check', emoji: null,
    colorHex: '#4f7f73', memory: null, takenAt: null, isFavorite: false,
    reactions: {}, uploadedBy: null, createdAt: '2026-09-01T12:00:00Z',
  }
  let parentReads = 0
  await page.route('**/api/photos', route => route.fulfill({ json: { photos: [photo] } }))
  await page.route('**/api/photos/photo-1', async route => {
    expect(route.request().headers().authorization).toBe('Bearer test-access')
    parentReads += 1
    await route.fulfill({ json: { photo: { ...photo, imageUrl: freshURL } } })
  })
  await page.route('**/media/test-family/photo.png?**', async route => {
    if (new URL(route.request().url()).searchParams.get('sig') === 'stale') {
      await route.fulfill({ status: 403, body: 'Expired media URL' })
    } else {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') })
    }
  })

  await signIn(page)
  // Run under the shipped worker: media must bypass its public-asset cache so
  // expiration reaches the server, just as authenticated API requests do.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await page.getByRole('link', { name: 'Photos', exact: true }).click()
  const gridImage = page.locator('.ph-tile img').first()
  await expect(gridImage).toHaveAttribute('src', freshURL)
  await expect.poll(() => gridImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  // The featured photo and its grid tile each recover their own image.
  await expect(page.locator('.ph-banner-tile img')).toHaveAttribute('src', freshURL)
  await expect(page.locator('img[src*="/media/test-family/"]')).toHaveCount(2)
  expect(parentReads).toBe(2)

  await gridImage.click()
  const detailImage = page.locator('.pd-stage img')
  await expect(detailImage).toHaveAttribute('src', freshURL)
  await expect.poll(() => detailImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  expect(parentReads).toBe(3)
  const cachedMedia = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      urls.push(...(await cache.keys()).map(request => request.url))
    }
    return urls.filter(url => new URL(url).pathname.startsWith('/media/'))
  })
  expect(cachedMedia).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('photo-media-recovery.png'), fullPage: true })
})
