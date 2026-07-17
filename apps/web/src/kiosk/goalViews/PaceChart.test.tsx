import { render, screen } from '@testing-library/react'
import { PaceChart } from './PaceChart'
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

describe('PaceChart (fixed end date)', () => {
  const days: DayEntry[] = [{ dateKey: '2026-07-17', total: 560, perMember: {} }]
  const goal = makeGoal({ deadline: '2026-12-31' })
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: '2026-12-31', target: 1000, days })

  it('shows the "vs pace" pill with the signed delta', () => {
    render(<PaceChart goal={goal} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(stats.pace).not.toBeNull()
    const sign = stats.pace!.delta >= 0 ? '\\+' : ''
    expect(screen.getByText(new RegExp(`${sign}${Math.abs(stats.pace!.delta)}`))).toBeInTheDocument()
    expect(screen.getByText(/vs pace/)).toBeInTheDocument()
  })

  it('labels the pace line with the goal end date and shows a projected finish', () => {
    render(<PaceChart goal={goal} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText(/Pace to hit/)).toBeInTheDocument()
    expect(screen.getByText(/Projected finish/)).toBeInTheDocument()
  })

  it('shows today\'s cumulative total on the chart', () => {
    render(<PaceChart goal={goal} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText(/560/)).toBeInTheDocument()
  })
})

describe('PaceChart (open-ended)', () => {
  it('hides the "vs pace" pill and pace-line legend; shows a target line + projection instead', () => {
    const days: DayEntry[] = Array.from({ length: 10 }, (_, i) => ({
      dateKey: `2026-07-0${i + 1}`.length === 10 ? `2026-07-0${i + 1}` : `2026-07-${i + 1}`,
      total: 5,
      perMember: {},
    }))
    const goal = makeGoal({ deadline: null })
    const stats = computeGoalStats({ today: '2026-07-10', startDate: '2026-07-01', endDate: null, target: 1000, days })
    render(<PaceChart goal={goal} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.queryByText(/vs pace/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Pace to hit/)).not.toBeInTheDocument()
    expect(screen.getByText(/On track to finish|Keep going/)).toBeInTheDocument()
  })
})
