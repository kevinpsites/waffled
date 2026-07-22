import { render, screen } from '@testing-library/react'
import { YearRing } from './YearRing'
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

describe('YearRing', () => {
  const days: DayEntry[] = [
    { dateKey: '2026-02-10', total: 10, perMember: {} },
    { dateKey: '2026-07-10', total: 8.3, perMember: {} },
  ]
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })

  it('draws 12 month wedge tracks', () => {
    const { container } = render(<YearRing goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(container.querySelectorAll('.gdv-ring-track')).toHaveLength(12)
  })

  it('shows the lifetime total and target in the center disk', () => {
    render(<YearRing goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText('18.3')).toBeInTheDocument() // 10 + 8.3
    expect(screen.getByText(/of 1,000/)).toBeInTheDocument()
  })
})
