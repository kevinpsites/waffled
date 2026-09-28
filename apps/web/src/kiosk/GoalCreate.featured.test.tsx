import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { GoalCreate } from './GoalCreate'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// `?featured=1` — the one param that pre-picks a tier, sent by Weekly Planning's Goals
// step so a new goal comes back already pinned. Narrow and additive: with the param
// absent the editor still opens on Normal.

const lists = [
  {
    id: 'l-family', name: 'Family', emoji: '🏡', colorHex: null, isPrivate: false, sortOrder: 0,
    members: [
      { personId: 'p1', name: 'Kevin', avatarEmoji: '🙂', colorHex: null },
      { personId: 'p2', name: 'Kelly', avatarEmoji: '🙃', colorHex: null },
    ],
    goalCount: 0,
  },
]

const me = { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, capabilities: ['goal.manage'] }

let posted: Record<string, unknown> | null = null

// `householdDelay` staggers the editor's two independent mount fetches. Not decoration:
// resolving both in one tick batches their state updates, so the "is this list a legal
// target?" effect never sees a half-loaded viewer and the bug below tests green.
function mockApi(householdDelay = 0, capabilities: string[] = ['goal.manage']) {
  posted = null
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (method === 'POST' && u.endsWith('/api/goals')) {
      posted = JSON.parse(String(init?.body))
      return { ok: true, json: async () => ({ goal: { id: 'g-new' } }) }
    }
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists }) }
    if (u.includes('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) }
    if (u.includes('/api/household')) {
      if (householdDelay) await new Promise((r) => setTimeout(r, householdDelay))
      return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { ...me, capabilities } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

// Cancel/Create live in the topbar slot, so the harness must render it to press Create.
function Topbar() {
  const { full } = useTopbarSlots()
  return <div data-testid="topbar">{full}</div>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TopbarSlotProvider>
        <Topbar />
        <Routes>
          <Route path="/goals/new" element={<GoalCreate />} />
          <Route path="/goals" element={<div>goals list sentinel</div>} />
          <Route path="/goals/:id" element={<div>goal detail sentinel</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

beforeEach(() => mockApi())

describe('GoalCreate · ?featured=1', () => {
  it('opens on the Pinned tier and creates the goal already featured', async () => {
    renderAt('/goals/new?list=l-family&featured=1')
    await waitFor(() => expect(screen.getByRole('button', { name: /📌 Pinned/ })).toHaveClass('on'))

    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Create goal' }))
    await waitFor(() => expect(posted).not.toBe(null))
    expect(posted).toMatchObject({ title: 'Walk after dinner', goalListId: 'l-family', isFeatured: true })
    // The param pins; it must never promote to the one-per-list hero.
    expect(posted!.isSpotlight).toBe(false)
  })

  it('changes nothing when the param is absent — the tier still defaults to Normal', async () => {
    renderAt('/goals/new?list=l-family')
    await waitFor(() => expect(screen.getByRole('button', { name: /Normal/ })).toHaveClass('on'))
    expect(screen.getByRole('button', { name: /📌 Pinned/ })).not.toHaveClass('on')
  })

  it('treats any value other than 1 as absent, rather than as truthy', async () => {
    renderAt('/goals/new?list=l-family&featured=0')
    await waitFor(() => expect(screen.getByRole('button', { name: /Normal/ })).toHaveClass('on'))
  })
})

// Targeting a *shared* group depends on `goal.manage`, and the effect that neutralizes an
// illegal `?list=` reads "viewer not loaded yet" as "viewer holds nothing" — so if the
// lists win the mount race it clears a legal prefill permanently. The gate must be "wait
// until the household has answered", the only moment a capability check is honest.
describe('GoalCreate · the ?list= prefill survives the load order', () => {
  it('keeps the group when the household answers after the lists', async () => {
    mockApi(30)
    renderAt('/goals/new?list=l-family&featured=1')
    // Before the viewer lands the chip isn't offered at all.
    const chip = await screen.findByRole('button', { name: /Family/ })
    expect(chip).toHaveClass('on')

    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Create goal' }))
    await waitFor(() => expect(posted).not.toBe(null))
    expect(posted).toMatchObject({ goalListId: 'l-family', isFeatured: true })
  })

  // Why the gate is "wait" and not "skip": a slow household DELAYS the capability check,
  // never cancels it, so an illegal prefill is still thrown away — just a moment later.
  it('still clears a group this viewer may not target, once the household says so', async () => {
    mockApi(30, [])
    renderAt('/goals/new?list=l-family&featured=1')
    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create goal' })).toBeEnabled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create goal' })).toBeDisabled())
    expect(screen.queryByRole('button', { name: /^Family/ })).not.toBeInTheDocument()
    expect(posted).toBe(null)
  })
})

// The embedded editor — the same component, no route. Weekly Planning's Goals step renders
// it in a modal because navigating to /goals/new abandons the session. `embed` fixes the
// group, reports back instead of navigating, and leaves route behaviour untouched.
describe('GoalCreate · embedded', () => {
  it('fixes the group, hides the picker, and reports back instead of navigating', async () => {
    const onCreated = vi.fn()
    render(
      <MemoryRouter initialEntries={['/planning/goals']}>
        <TopbarSlotProvider>
          <Topbar />
          <GoalCreate embed={{ listId: 'l-family', featured: true, onCreated }} />
        </TopbarSlotProvider>
      </MemoryRouter>
    )
    // The group is stated, not offered: no chip to press, and no "＋ New group" either.
    const locked = await screen.findByTestId('ge-who-locked')
    expect(locked).toHaveTextContent('Family')
    expect(screen.queryByRole('button', { name: /＋ New group/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Family/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('topbar')).toBeEmptyDOMElement()
    expect(screen.getByRole('button', { name: /📌 Pinned/ })).toHaveClass('on')

    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(posted).toMatchObject({ title: 'Walk after dinner', goalListId: 'l-family', isFeatured: true })
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})
