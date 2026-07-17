import { render, screen, fireEvent } from '@testing-library/react'
import { WeekHeatmap } from './WeekHeatmap'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant } from '../../lib/api'

const participants: GoalParticipant[] = [
  { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: null, progress: 0 },
]
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

// A week ending Fri 2026-07-17, with Sat 2026-07-11 excluded (8 days back).
const days: DayEntry[] = [
  { dateKey: '2026-07-11', total: 5.9, perMember: { p1: 5.9 } },
  { dateKey: '2026-07-15', total: 1.5, perMember: { p1: 1.5 } },
  { dateKey: '2026-07-16', total: 3.9, perMember: { p1: 3.9 } },
  { dateKey: '2026-07-17', total: 2.5, perMember: { p1: 2.5 } },
]

describe('WeekHeatmap', () => {
  it('renders 7 day cells with the correct weekday labels, today highlighted', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    // last 7 days ending Fri 2026-07-17: Sat 11 .. Fri 17
    expect(screen.getAllByText(/^(Sa|Su|Mo|Tu|We|Th|Fr)$/)).toHaveLength(7)
    const today = screen.getByText('Fr')
    expect(today).toHaveStyle({ color: 'var(--primary)' })
  })

  it('shows a quiet "·" for a zero day, not an empty bar', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    // Sun 07-12 has no log at all -> quiet dot, not "0"
    expect(screen.getAllByText('·').length).toBeGreaterThan(0)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('summarizes the week total and unit', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    const { container } = render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(container.querySelector('.gdv-summary-n')?.textContent).toBe('13.8') // 5.9+1.5+3.9+2.5
    expect(screen.getByText(/hrs this week/)).toBeInTheDocument()
  })

  it('calls onDayClick with that day\'s dateKey when a cell is tapped', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    const onDayClick = vi.fn()
    render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={onDayClick} onMonthClick={() => {}} />)
    fireEvent.click(screen.getByText('Fr'))
    expect(onDayClick).toHaveBeenCalledWith('2026-07-17')
  })
})
