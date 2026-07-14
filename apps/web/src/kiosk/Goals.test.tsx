import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Goals } from './Goals'

const familyList = {
  id: 'l1',
  name: 'Family',
  emoji: '🏡',
  colorHex: null,
  isPrivate: false,
  sortOrder: 0,
  members: [
    { personId: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED' },
    { personId: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' },
  ],
  goalCount: 2,
}

const featured = {
  id: 'g1',
  goalListId: 'l1',
  title: '1,000 Hours Outside',
  emoji: '🌲',
  category: 'physical',
  goalType: 'total',
  unit: 'hours',
  habitPeriod: null,
  habitTargetPerPeriod: null,
  trackingMode: 'shared_total',
  logMethod: 'quick_log',
  deadline: null,
  isFeatured: false,
  isSpotlight: true, // the hero is now the Spotlight tier
  hasRewards: false,
  target: 1000,
  totalProgress: 312,
  milestoneTotal: 0,
  milestoneReached: 0,
  streakDays: 9,
  participants: [
    { personId: 'p1', name: 'Kevin', colorHex: '#2F7FED', avatarEmoji: '🐻', target: 1000, progress: 102 },
    { personId: 'p2', name: 'Kelly', colorHex: '#EC6049', avatarEmoji: '🦊', target: 1000, progress: 64 },
  ],
}

const moreGoal = {
  ...featured,
  id: 'g2',
  title: 'Dinner together',
  emoji: '🍽️',
  category: 'social',
  goalType: 'habit',
  unit: null,
  habitPeriod: 'week',
  habitTargetPerPeriod: 5,
  isFeatured: false,
  isSpotlight: false,
  target: 5,
  totalProgress: 4,
  streakDays: 0,
  participants: [],
}

function mockApi(opts: { lists?: unknown[]; goals?: unknown[]; logged?: unknown[]; person?: unknown; patched?: { url: string; body: unknown }[] }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists: opts.lists ?? [] }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: opts.person ?? null }) }
    if (/\/api\/goals\/[^/]+\/log$/.test(u) && init?.method === 'POST') {
      opts.logged?.push(JSON.parse(init.body!))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (/\/api\/goals\/[^/]+$/.test(u) && init?.method === 'PATCH') {
      opts.patched?.push({ url: u, body: JSON.parse(init.body!) })
      return { ok: true, json: async () => ({ goal: {} }) }
    }
    if (u.includes('/api/goals')) return { ok: true, json: async () => ({ goals: opts.goals ?? [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/goals']}>
      <Goals />
    </MemoryRouter>
  )
}

describe('Goals home (goal-lists model)', () => {
  it('renders the list rail, list header, featured hero and more goals', async () => {
    mockApi({ lists: [familyList], goals: [featured, moreGoal] })
    renderHome()

    // list rail + header
    expect(await screen.findAllByText('Family')).not.toHaveLength(0)
    expect(screen.getAllByText(/Kevin & Kelly/i).length).toBeGreaterThan(0)

    // spotlight hero
    expect(screen.getByText('1,000 Hours Outside')).toBeInTheDocument()
    expect(screen.getByText(/Spotlight · shared total/)).toBeInTheDocument()
    expect(screen.getByText(/9-day streak/)).toBeInTheDocument()

    // more goals with type descriptor
    expect(screen.getByText('Dinner together')).toBeInTheDocument()
    expect(screen.getByText(/Habit · 5× a week/)).toBeInTheDocument()
  })

  it('logs progress from the hero Log button', async () => {
    const logged: unknown[] = []
    mockApi({ lists: [familyList], goals: [featured], logged })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /Log hours/ }))
    const modal = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(within(modal).getByRole('button', { name: /^Log \d/ }))
    await waitFor(() => expect(logged).toHaveLength(1))
    // A time goal (hours) logs hours + minutes; the server folds them to decimal hours.
    expect(logged[0]).toMatchObject({ hours: 1, minutes: 0 })
  })

  it('pins a "More" goal from its card (quick PATCH, no edit form)', async () => {
    const patched: { url: string; body: unknown }[] = []
    const person = { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, capabilities: ['goal.manage'] }
    // featured = the Spotlight hero; moreGoal ("Dinner together") is a plain "More" card.
    mockApi({ lists: [familyList], goals: [featured, moreGoal], person, patched })
    renderHome()
    const card = (await screen.findByText('Dinner together')).closest('.goal-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /^Pin/i }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0].url).toContain('/api/goals/g2')
    expect(patched[0].body).toMatchObject({ isFeatured: true })
  })

  it('renders the orange each-tracks hero variant', async () => {
    const eachGoal = { ...featured, trackingMode: 'each_tracks', title: 'Summer Reading Challenge' }
    mockApi({ lists: [familyList], goals: [eachGoal] })
    renderHome()
    expect(await screen.findByText('Summer Reading Challenge')).toBeInTheDocument()
    expect(screen.getByText(/Spotlight · each tracks their own/)).toBeInTheDocument()
    expect(screen.getByText('TOGETHER')).toBeInTheDocument()
  })
})
