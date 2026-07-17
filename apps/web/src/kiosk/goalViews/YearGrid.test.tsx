import { render, screen } from '@testing-library/react'
import { YearGrid } from './YearGrid'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant } from '../../lib/api'

const personMap = new Map<string, GoalParticipant>()

function makeGoal(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: 'g1', goalListId: null, title: 'G', emoji: null, category: null, goalType: 'total', unit: 'hrs',
    habitPeriod: null, habitTargetPerPeriod: null, trackingMode: 'shared_total', participantMode: 'split',
    targetBasis: 'family', logMethod: 'quick_log', autoFromCalendar: false, deadline: null, isFeatured: false,
    isSpotlight: false, hasRewards: false, target: 1000, totalProgress: 0, milestoneTotal: 0, milestoneReached: 0,
    periodDone: 0, stepTotal: 0, stepDone: 0, streakDays: 0, loggedTodayBy: [], participants: [],
    createdAt: '2026-01-01T00:00:00Z', milestones: [], steps: [], recent: [], thisWeek: 0,
    ...over,
  }
}

describe('YearGrid', () => {
  const days: DayEntry[] = [
    { dateKey: '2026-07-15', total: 1.5, perMember: {} },
    { dateKey: '2026-07-16', total: 3.9, perMember: {} },
    { dateKey: '2026-07-17', total: 2.5, perMember: {} },
  ]
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })

  it('renders one <rect> per day from the goal start through today, at least', () => {
    const { container } = render(<YearGrid goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    const rects = container.querySelectorAll('rect')
    // Jan 1 through Jul 17 2026 is 198 days; the grid may include a few blank
    // leading cells (padding to the first Sunday) but never fewer than the real days.
    expect(rects.length).toBeGreaterThanOrEqual(198)
  })

  it('shows the streak + active-day footer stats', () => {
    render(<YearGrid goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText(/current streak/)).toBeInTheDocument()
    expect(screen.getByText(/longest streak/)).toBeInTheDocument()
    expect(screen.getAllByText(/active days/).length).toBeGreaterThan(0)
  })
})
