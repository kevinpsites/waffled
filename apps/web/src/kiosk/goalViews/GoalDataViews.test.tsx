import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GoalDataViews } from './GoalDataViews'
import { getSavedView } from './persist'
import type { GoalDetail, GoalActivity } from '../../lib/api'

const goal: GoalDetail = {
  id: 'g1', goalListId: null, title: '1,000 Hours Outside', emoji: null, category: null, goalType: 'total', unit: 'hrs',
  habitPeriod: null, habitTargetPerPeriod: null, trackingMode: 'shared_total', participantMode: 'split',
  targetBasis: 'family', logMethod: 'quick_log', autoFromCalendar: false, deadline: '2026-12-31', isFeatured: false,
  isSpotlight: false, hasRewards: false, target: 1000, totalProgress: 560, milestoneTotal: 0, milestoneReached: 0,
  periodDone: 0, stepTotal: 0, stepDone: 0, streakDays: 3, loggedTodayBy: [],
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: null, progress: 560 }],
  createdAt: '2026-01-01T00:00:00Z', milestones: [], steps: [],
  recent: [{ id: 'r1', amount: 2.5, loggedAt: '2026-07-17T14:00:00Z', dateKey: '2026-07-17', note: 'Creek hike', participants: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }] }],
  thisWeek: 14.5,
}

const activity = {
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  today: '2026-07-17',
  days: [{ dateKey: '2026-07-17', total: 2.5, perMember: { p1: 2.5 } }],
}

beforeEach(() => {
  localStorage.clear()
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/activity')) return { ok: true, json: async () => activity }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

describe('GoalDataViews', () => {
  it('defaults to the type\'s signature view (Month for a total goal) and offers the type\'s view list', async () => {
    render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    expect(screen.getByText('July')).toBeInTheDocument() // Month's title
    for (const label of ['Week', 'Month', 'Pace', 'Year', 'By person', 'Year ring']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('switching views persists the choice for this goal', async () => {
    render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    fireEvent.click(screen.getByText('Month'))
    expect(screen.getByText('July')).toBeInTheDocument() // Month's title
    expect(getSavedView('g1')).toBe('month')
  })

  it('restores the persisted view on next mount', async () => {
    render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    fireEvent.click(screen.getByText('Year'))
    expect(getSavedView('g1')).toBe('year')

    const { unmount } = render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.getAllByText('The whole year').length).toBeGreaterThan(0))
    unmount()
  })

  it('tapping a day cell opens the day-detail popover', async () => {
    render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    fireEvent.click(screen.getByText('Week'))
    fireEvent.click(screen.getByText('Fri 17')) // today's dated weekday label sits inside the clickable cell button
    expect(await screen.findByText('Creek hike')).toBeInTheDocument()
  })

  it('tapping a By-person month column opens the MONTH popover, not a synthesized day-1', async () => {
    render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    fireEvent.click(screen.getByText('By person'))
    fireEvent.click(screen.getByText('Jul')) // the July column
    expect(await screen.findByText('July 2026')).toBeInTheDocument()
    expect(screen.getByText('Creek hike')).toBeInTheDocument() // Jul 17 entry, correctly scoped to the month
  })

  it('shows a loading state while the activity fetch is pending', () => {
    // `offered` derives from `timeframe`, which is null until `activity` resolves —
    // so before the fetch settles, offered is [] just like a checklist goal. The
    // loading check must run BEFORE the "offered is empty" checklist early-return,
    // or this state is unreachable and the card renders blank instead.
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch // never resolves
    render(<GoalDataViews goal={goal} />)
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
  })

  it('shows an error state (not a blank card) when the activity fetch fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    const { container } = render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    expect(screen.getByText(/Couldn't load/)).toBeInTheDocument()
    expect(container.textContent).not.toBe('')
  })

  it('does not show the previous goal\'s stale activity while a newly-selected goal\'s fetch is still pending', async () => {
    const { container, rerender } = render(<GoalDataViews goal={goal} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    expect(container.querySelector('.gdv-head-sub')?.textContent).toMatch(/2\.5/) // goal A's "2.5 hrs this month"

    // Switch to a different goal whose /activity fetch never resolves. If the
    // hook doesn't clear the previous `activity` on an id change, goal A's stats
    // (and thus its "2.5" figure) would keep rendering under goal B's header for
    // as long as B's fetch takes — not just a single frame.
    const goalB: GoalDetail = { ...goal, id: 'g2', title: 'Different goal' }
    globalThis.fetch = vi.fn((url: string) => {
      if (String(url).includes('/activity')) return new Promise<GoalActivity>(() => {}) // never resolves
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    }) as unknown as typeof fetch
    rerender(<GoalDataViews goal={goalB} />)

    expect(screen.getByText(/Loading/)).toBeInTheDocument()
    expect(container.querySelector('.gdv-head-sub')).toBeNull()
  })

  it('renders nothing (not a stuck loading state) for a checklist goal, once activity resolves', async () => {
    // A checklist goal's `offered` list is permanently empty, and its view-selection
    // effect never sets `view` (there's nothing to default to) — so a naive
    // "loading" check built from `!view` alone would never resolve for this type.
    const { container } = render(<GoalDataViews goal={{ ...goal, goalType: 'checklist' }} />)
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument())
    expect(container.firstChild).toBeNull()
  })
})
