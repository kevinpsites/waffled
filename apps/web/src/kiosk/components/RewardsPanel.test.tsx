import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RewardsPanel } from './RewardsPanel'

// The shop drives its data off the rewards hub (/api/rewards + /api/balances +
// /api/redemptions), the active kid's overview (/api/persons/:id/overview → the
// saving-toward panel) and /api/household (the current caller + capabilities).
// Rather than mock the hooks, we mock fetch at the endpoint level (as the other
// kiosk tests do) so the real hooks and redeem/award paths exercise.

const currencies = [{ id: 'c1', key: 'stars', label: 'Stars', symbol: '⭐', color: '#f2b01e', isDefault: true, spendable: true, sortOrder: 0 }]

// Wally has 8 stars: enough for the 5-star treat, not the 20-star adventure.
const balances = [
  { personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', stars: 8, balances: [{ currency: 'stars', balance: 8 }], recent: [] },
]

const rewards = [
  { id: 'r1', title: 'Ice cream', emoji: '🍦', cost: 5, currency: 'stars', category: 'treats', sortOrder: 0, requiresApproval: false },
  { id: 'r2', title: 'Theme park', emoji: '🎢', cost: 20, currency: 'stars', category: 'adventures', sortOrder: 1, requiresApproval: false },
]

const overview = {
  person: { id: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', age: 8, memberType: 'kid' },
  activeGoals: 0, topStreak: 0, stars: 8, currencies, balances: [{ currency: 'stars', balance: 8 }],
  goals: [], categoryBalance: [], insight: { lean: [], light: [], suggestions: [], text: '' },
  recentLedger: [], redemptions: [], rewardShop: [],
  savingToward: { id: 'r2', title: 'Theme park', emoji: '🎢', cost: 20, currency: 'stars', have: 8, toGo: 12, pct: 40 },
  streak: { days: 0, week: [] },
}

const me = (capabilities: string[]) => ({ id: 'p9', name: 'Kevin', memberType: 'adult', isAdmin: false, capabilities })

let redeemBody: unknown = null
function mockApi(person: unknown) {
  redeemBody = null
  globalThis.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/rewards/') && u.endsWith('/redeem')) {
      redeemBody = opts?.body ? JSON.parse(String(opts.body)) : null
      return { ok: true, status: 201, json: async () => ({ redemption: { id: 'red1', rewardId: 'r1', personId: 'p1', status: 'approved', title: 'Ice cream', emoji: '🍦', cost: 5, currency: 'stars' } }) }
    }
    if (u.includes('/api/rewards/archived')) return { ok: true, json: async () => ({ rewards: [] }) }
    if (u.includes('/api/rewards')) return { ok: true, json: async () => ({ rewards }) }
    if (u.includes('/api/balances')) return { ok: true, json: async () => ({ currencies, people: balances }) }
    if (u.includes('/api/redemptions')) return { ok: true, json: async () => ({ redemptions: [] }) }
    if (u.includes('/api/persons/p1/overview')) return { ok: true, json: async () => overview }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderShop() {
  return render(<MemoryRouter><RewardsPanel /></MemoryRouter>)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('Reward Shop', () => {
  it('locks a reward the active kid can’t afford (progress, no Get) and offers Get on affordable ones', async () => {
    mockApi(me([]))
    renderShop()

    // Affordable treat → a "Get it" button.
    const ice = await screen.findByText('Ice cream')
    const iceTile = ice.closest('.shop-tile') as HTMLElement
    expect(within(iceTile).getByRole('button', { name: /get it/i })).toBeInTheDocument()

    // Unaffordable adventure → locked: shows "N more to unlock", no Get.
    const park = screen.getByText('Theme park')
    const parkTile = park.closest('.shop-tile') as HTMLElement
    expect(parkTile.className).toMatch(/locked/)
    expect(within(parkTile).getByText(/12 more to unlock/i)).toBeInTheDocument()
    expect(within(parkTile).queryByRole('button', { name: /get it/i })).not.toBeInTheDocument()
  })

  it('filters the grid by category chip', async () => {
    mockApi(me([]))
    renderShop()
    await screen.findByText('Ice cream')
    // scope to the grid — "Theme park" also appears in the saving-toward panel
    const grid = () => document.querySelector('.shop-grid') as HTMLElement
    expect(within(grid()).getByText('Theme park')).toBeInTheDocument()

    // Pick the Treats chip → only the treat remains in the grid.
    fireEvent.click(screen.getByRole('tab', { name: /treats/i }))
    expect(within(grid()).getByText('Ice cream')).toBeInTheDocument()
    expect(within(grid()).queryByText('Theme park')).not.toBeInTheDocument()
  })

  it('renders the active kid’s saving-toward panel from the overview', async () => {
    mockApi(me([]))
    renderShop()
    expect(await screen.findByText(/12 ★ to go/i)).toBeInTheDocument()
  })

  it('redeeming an affordable reward opens the celebration for the active kid', async () => {
    mockApi(me([]))
    renderShop()
    const ice = await screen.findByText('Ice cream')
    const iceTile = ice.closest('.shop-tile') as HTMLElement

    fireEvent.click(within(iceTile).getByRole('button', { name: /get it/i }))
    // confirm sheet
    const confirm = await screen.findByRole('button', { name: /redeem it/i })
    fireEvent.click(confirm)

    // redeem hit the API for the active kid, then the celebration shows.
    await waitFor(() => expect(redeemBody).toEqual({ personId: 'p1' }))
    expect(await screen.findByText(/unlocked!/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to shop/i })).toBeInTheDocument()
  })

  it('shows the parent "Award stars" button (reward.grant) and it opens SpotAwardModal', async () => {
    mockApi(me(['reward.grant']))
    renderShop()
    const awardBtn = await screen.findByRole('button', { name: /award stars/i })
    fireEvent.click(awardBtn)
    // SpotAwardModal renders its "Who?" picker (no preset) with the kid roster.
    expect(await screen.findByRole('radiogroup', { name: /family member/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Wally/i })).toBeInTheDocument()
  })

  it('hides "Award stars" from someone without reward.grant', async () => {
    mockApi(me([]))
    renderShop()
    await screen.findByText('Ice cream')
    expect(screen.queryByRole('button', { name: /award stars/i })).not.toBeInTheDocument()
  })
})
