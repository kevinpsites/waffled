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
  it('renders the fixed Sun–Sat week containing today, today highlighted', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    // today Fri 2026-07-17 → the calendar week is Sun Jul 12 .. Sat Jul 18 (not rolling)
    // Each day label carries its date, e.g. "Sun 12" … "Sat 18".
    expect(screen.getAllByText(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}$/)).toHaveLength(7)
    expect(screen.getByText('Sun 12')).toBeInTheDocument()
    expect(screen.getByText('Sat 18')).toBeInTheDocument()
    expect(screen.getByText(/Jul 12 – Jul 18/)).toBeInTheDocument()
    const today = screen.getByText('Fri 17')
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
    // Sun Jul 12 .. Sat Jul 18: Jul 15+16+17 only; Sat Jul 11 is the PRIOR week now
    expect(container.querySelector('.gdv-summary-n')?.textContent).toBe('7.9') // 1.5+3.9+2.5
    expect(screen.getByText(/hrs this week/)).toBeInTheDocument()
  })

  it('calls onDayClick with that day\'s dateKey when a cell is tapped', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    const onDayClick = vi.fn()
    render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={onDayClick} onMonthClick={() => {}} />)
    fireEvent.click(screen.getByText('Fri 17'))
    expect(onDayClick).toHaveBeenCalledWith('2026-07-17')
  })

  it('navigates to the previous week, and blocks paging past the current week', () => {
    const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    render(<WeekHeatmap goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    expect(screen.getByText('That week')).toBeInTheDocument()
    // previous calendar week: Sun Jul 5 .. Sat Jul 11
    expect(screen.getByText(/Jul 5 – Jul 11/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next week' })).not.toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    expect(screen.getByText('This week')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled()
  })
})
