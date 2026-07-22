import { render } from '@testing-library/react'
import { ByPersonBars } from './ByPersonBars'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant } from '../../lib/api'

const participants: GoalParticipant[] = [
  { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: null, progress: 0 },
  { personId: 'p2', name: 'Kevin', colorHex: '#2F7FED', avatarEmoji: '🐻', target: null, progress: 0 },
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

describe('ByPersonBars', () => {
  const days: DayEntry[] = [
    { dateKey: '2026-02-10', total: 10, perMember: { p1: 6, p2: 4 } },
    { dateKey: '2026-07-10', total: 8.3, perMember: { p1: 4, p2: 4.3 } },
  ]
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })

  it('shows a month column for every month from Jan through the current month', () => {
    const { container } = render(<ByPersonBars goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    expect(container.querySelectorAll('.gdv-byperson-col')).toHaveLength(7) // Jan..Jul
  })

  it('renders a per-person total chip with each person\'s lifetime total', () => {
    const { container } = render(<ByPersonBars goal={makeGoal()} stats={stats} personMap={personMap} onDayClick={() => {}} onMonthClick={() => {}} />)
    const chips = container.querySelectorAll('.gdv-byperson-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].textContent).toContain('Wally')
    expect(chips[0].textContent).toContain('10') // Wally's total (6+4)
    expect(chips[1].textContent).toContain('Kevin')
    expect(chips[1].textContent).toContain('8.3') // Kevin's total (4+4.3)
  })
})
