import { render, screen } from '@testing-library/react'
import { MonthDetailPopover } from './MonthDetailPopover'
import { computeGoalStats, type DayEntry } from '../../lib/goalStats'
import type { GoalDetail, GoalParticipant, GoalLogEntry } from '../../lib/api'

const participants: GoalParticipant[] = [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: null, progress: 0 }]
const personMap = new Map(participants.map((p) => [p.personId, p]))

function makeGoal(recent: GoalLogEntry[]): GoalDetail {
  return {
    id: 'g1', goalListId: null, title: 'G', emoji: null, category: null, goalType: 'total', unit: 'hrs',
    habitPeriod: null, habitTargetPerPeriod: null, trackingMode: 'shared_total', participantMode: 'split',
    targetBasis: 'family', logMethod: 'quick_log', autoFromCalendar: false, deadline: null, isFeatured: false,
    isSpotlight: false, hasRewards: false, target: 1000, totalProgress: 0, milestoneTotal: 0, milestoneReached: 0,
    periodDone: 0, stepTotal: 0, stepDone: 0, streakDays: 0, loggedTodayBy: [], participants,
    createdAt: '2026-01-01T00:00:00Z', milestones: [], steps: [], recent, thisWeek: 0,
  }
}

describe('MonthDetailPopover', () => {
  const days: DayEntry[] = [
    { dateKey: '2026-02-05', total: 4, perMember: { p1: 4 } },
    { dateKey: '2026-02-20', total: 6, perMember: { p1: 6 } },
    { dateKey: '2026-03-01', total: 9, perMember: { p1: 9 } }, // different month — must not leak in
  ]
  const stats = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })

  it('sums only that month\'s days into the total, not other months', () => {
    const { container } = render(
      <MonthDetailPopover
        year={2026}
        month={1} // February (0-indexed)
        goal={makeGoal([])}
        stats={stats}
        personMap={personMap}
        onClose={() => {}}
      />
    )
    expect(container.querySelector('.tiny.muted')?.textContent).toBe('10 hrs logged') // 4 + 6, NOT 19 (March leaking in)
  })

  it('lists recent entries that fall within the month, excluding entries from other months', () => {
    const goal = makeGoal([
      { id: 'r1', amount: 4, loggedAt: '2026-02-05T14:00:00Z', dateKey: '2026-02-05', note: 'Feb hike', participants: [] },
      { id: 'r2', amount: 9, loggedAt: '2026-03-01T14:00:00Z', dateKey: '2026-03-01', note: 'March hike', participants: [] },
    ])
    render(<MonthDetailPopover year={2026} month={1} goal={goal} stats={stats} personMap={personMap} onClose={() => {}} />)
    expect(screen.getByText('Feb hike')).toBeInTheDocument()
    expect(screen.queryByText('March hike')).not.toBeInTheDocument()
  })

  it('matches entries by the household-tz dateKey, not a re-parse of loggedAt in the viewer\'s own timezone', () => {
    // dateKey says Jan 31 (household tz), but the raw UTC instant is already Feb 1
    // — a device-tz re-parse of loggedAt could easily land on the wrong month.
    const goal = makeGoal([
      { id: 'r1', amount: 4, loggedAt: '2026-02-01T05:30:00Z', dateKey: '2026-01-31', note: 'Late Jan', participants: [] },
    ])
    render(<MonthDetailPopover year={2026} month={0} goal={goal} stats={stats} personMap={personMap} onClose={() => {}} />)
    expect(screen.getByText('Late Jan')).toBeInTheDocument()
  })

  it('does not repeat the per-member totals once matching entries are already listed', () => {
    // Feb 5 and Feb 20 both have real logged entries below AND per-member totals
    // in `stats` — the per-member block is a fallback for entries older than the
    // kept `recent` log, not a redundant summary alongside entries already shown.
    const goal = makeGoal([
      { id: 'r1', amount: 4, loggedAt: '2026-02-05T14:00:00Z', dateKey: '2026-02-05', note: 'Feb hike', participants: [] },
      { id: 'r2', amount: 6, loggedAt: '2026-02-20T14:00:00Z', dateKey: '2026-02-20', note: 'Another hike', participants: [] },
    ])
    render(<MonthDetailPopover year={2026} month={1} goal={goal} stats={stats} personMap={personMap} onClose={() => {}} />)
    expect(screen.getByText('Feb hike')).toBeInTheDocument()
    expect(screen.queryByText('Wally')).not.toBeInTheDocument()
    expect(screen.queryByText(/kept in the recent log/)).not.toBeInTheDocument()
  })
})
