import { render, screen } from '@testing-library/react'
import { CollectionGrid } from './CollectionGrid'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant } from '../../lib/api'

const personMap = new Map<string, GoalParticipant>()

function makeGoal(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: 'g1', goalListId: null, title: 'Read 20 books', emoji: null, category: null, goalType: 'count', unit: 'books',
    habitPeriod: null, habitTargetPerPeriod: null, trackingMode: 'shared_total', participantMode: 'split',
    targetBasis: 'family', logMethod: 'quick_log', autoFromCalendar: false, deadline: null, isFeatured: false,
    isSpotlight: false, hasRewards: false, target: 20, totalProgress: 12, milestoneTotal: 0, milestoneReached: 0,
    periodDone: 0, stepTotal: 0, stepDone: 0, streakDays: 0, loggedTodayBy: [], participants: [],
    createdAt: '2026-01-01T00:00:00Z', milestones: [], steps: [], recent: [], thisWeek: 0,
    ...over,
  }
}

describe('CollectionGrid', () => {
  const days: DayEntry[] = [{ dateKey: '2026-03-01', total: 12, perMember: {} }]
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 20, days })

  it('renders `target` slots, the first `done` filled', () => {
    const { container } = render(<CollectionGrid goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    const slots = container.querySelectorAll('.gdv-collection-slot')
    expect(slots).toHaveLength(20)
    expect(container.querySelectorAll('.gdv-collection-slot.filled')).toHaveLength(12)
  })

  it('shows the "N of target" caption', () => {
    render(<CollectionGrid goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText(/12/)).toBeInTheDocument()
    expect(screen.getByText(/of 20/)).toBeInTheDocument()
  })
})
