import { render, screen, fireEvent } from '@testing-library/react'
import { MonthHeatmap } from './MonthHeatmap'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant } from '../../lib/api'

const participants: GoalParticipant[] = [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: null, progress: 0 }]
const personMap = new Map(participants.map((p) => [p.personId, p]))

function makeGoal(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: 'g1', goalListId: null, title: 'G', emoji: null, category: null, goalType: 'total', unit: 'hrs',
    habitPeriod: null, habitTargetPerPeriod: null, trackingMode: 'shared_total', participantMode: 'split',
    targetBasis: 'family', logMethod: 'quick_log', autoFromCalendar: false, deadline: null, isFeatured: false,
    isSpotlight: false, hasRewards: false, target: 1000, totalProgress: 0, milestoneTotal: 0, milestoneReached: 0,
    periodDone: 0, stepTotal: 0, stepDone: 0, streakDays: 0, loggedTodayBy: [], participants,
    createdAt: '2026-01-01T00:00:00Z', milestones: [], steps: [], recent: [], thisWeek: 0,
    ...over,
  }
}

// July 2026: 31 days, Jul 1 is a Wednesday.
const days: DayEntry[] = [
  { dateKey: '2026-07-01', total: 2, perMember: { p1: 2 } },
  { dateKey: '2026-07-10', total: 8.3, perMember: { p1: 8.3 } },
  { dateKey: '2026-07-17', total: 2.5, perMember: { p1: 2.5 } },
]

describe('MonthHeatmap', () => {
  it('renders a 7-col grid with leading blanks and all 31 July days', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    const { container } = render(<MonthHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(container.querySelectorAll('.gdv-month-cell')).toHaveLength(31)
    expect(container.querySelectorAll('.gdv-month-lead')).toHaveLength(3) // Jul 1 2026 is a Wednesday
  })

  it('shows future days as muted/dashed with no total', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    const { container } = render(<MonthHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    const future = container.querySelector('.gdv-month-cell.future')
    expect(future).toBeTruthy()
    expect(future?.textContent).not.toMatch(/\d+\.\d/) // no decimal total rendered
  })

  it('shows the month total and best day in the footer', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    render(<MonthHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByText(/12\.8/)).toBeInTheDocument() // 2 + 8.3 + 2.5 month total
    expect(screen.getByText(/Best day/)).toBeInTheDocument()
  })

  it('calls onDayClick with the tapped day\'s dateKey', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    const onDayClick = vi.fn()
    render(<MonthHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={onDayClick} onMonthClick={() => {}} />)
    fireEvent.click(screen.getByText('10'))
    expect(onDayClick).toHaveBeenCalledWith('2026-07-10')
  })
})
