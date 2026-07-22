import { render, screen } from '@testing-library/react'
import { ConsistencyCalendar } from './ConsistencyCalendar'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant } from '../../lib/api'

const personMap = new Map<string, GoalParticipant>()

function makeGoal(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: 'g1', goalListId: null, title: 'Meditate daily', emoji: null, category: null, goalType: 'habit', unit: null,
    habitPeriod: 'day', habitTargetPerPeriod: 1, trackingMode: 'each_tracks', participantMode: 'count_once',
    targetBasis: 'family', logMethod: 'quick_log', autoFromCalendar: false, deadline: null, isFeatured: false,
    isSpotlight: false, hasRewards: false, target: null, totalProgress: 0, milestoneTotal: 0, milestoneReached: 0,
    periodDone: 1, stepTotal: 0, stepDone: 0, streakDays: 3, loggedTodayBy: [], participants: [],
    createdAt: '2026-01-01T00:00:00Z', milestones: [], steps: [], recent: [], thisWeek: 0,
    ...over,
  }
}

describe('ConsistencyCalendar', () => {
  // July 2026: 1,2,3 done then a gap, then a fresh streak ending today (15,16,17).
  const hitDays = ['01', '02', '03', '15', '16', '17']
  const days: DayEntry[] = hitDays.map((d) => ({ dateKey: `2026-07-${d}`, total: 1, perMember: {} }))
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: null, days })

  it('renders one cell per day of the current month, hits filled and future days dashed', () => {
    const { container } = render(<ConsistencyCalendar goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(container.querySelectorAll('.gdv-consistency-cell')).toHaveLength(31)
    expect(container.querySelectorAll('.gdv-consistency-cell.hit')).toHaveLength(6)
    expect(container.querySelectorAll('.gdv-consistency-cell.future').length).toBeGreaterThan(0)
  })

  it('shows current/longest streak and this-month completion %', () => {
    render(<ConsistencyCalendar goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText(/🔥 3/)).toBeInTheDocument() // current streak from computeGoalStats
    expect(screen.getByText(/this month/)).toBeInTheDocument()
  })
})
