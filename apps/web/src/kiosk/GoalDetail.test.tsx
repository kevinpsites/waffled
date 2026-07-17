import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { GoalDetail } from './GoalDetail'

const detail = {
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
  isFeatured: true,
  hasRewards: true,
  target: 1000,
  totalProgress: 312,
  milestoneTotal: 3,
  milestoneReached: 1,
  streakDays: 9,
  createdAt: '2026-01-01T00:00:00Z',
  participants: [
    { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 1000, progress: 102 },
    { personId: 'p2', name: 'Kevin', colorHex: '#2F7FED', avatarEmoji: '🐻', target: 1000, progress: 78 },
  ],
  milestones: [
    { id: 'm1', threshold: 100, emoji: '🌱', label: '100 hrs', rewardText: 'reached', reached: true },
    { id: 'm2', threshold: 500, emoji: '⛺', label: '500 hrs', rewardText: 'camp', reached: false },
  ],
  recent: [{ id: 'r1', amount: 102, loggedAt: '2026-05-30T10:00:00Z', note: 'Creek hike', participants: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }] }],
  thisWeek: 14.5,
}

describe('GoalDetail', () => {
  it('renders the hero, milestones, the data-view switcher (defaulting to Pace) and recent activity', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      // /activity is checked first — its URL also contains "/api/goals/g1".
      if (String(url).includes('/activity')) {
        return { ok: true, json: async () => ({ startDate: '2026-01-01', endDate: null, today: '2026-07-17', days: [] }) }
      }
      if (String(url).includes('/api/goals/g1')) return { ok: true, json: async () => ({ goal: detail }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    render(
      <MemoryRouter initialEntries={['/goals/g1']}>
        <Routes>
          <Route path="/goals/:id" element={<GoalDetail />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByText('1,000 Hours Outside')).toBeInTheDocument()
    expect(screen.getByText(/9-day streak/)).toBeInTheDocument()
    expect(screen.getByText('100 hrs')).toBeInTheDocument() // milestone
    expect(await screen.findByText('Path to 1,000')).toBeInTheDocument() // data-view switcher, defaulted to Pace
    expect(screen.getByText('Creek hike')).toBeInTheDocument() // recent activity
  })
})
