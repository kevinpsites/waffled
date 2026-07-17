import { render, screen } from '@testing-library/react'
import { DayDetailPopover } from './DayDetailPopover'
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

describe('DayDetailPopover', () => {
  it('lists matching recent entries for the tapped day', () => {
    const goal = makeGoal([
      { id: 'r1', amount: 2.5, loggedAt: '2026-07-17T14:00:00Z', note: 'Creek hike', participants: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }] },
      { id: 'r2', amount: 4, loggedAt: '2026-06-01T14:00:00Z', note: 'Old entry', participants: [] },
    ])
    render(
      <DayDetailPopover
        dateKey="2026-07-17"
        dayEntry={{ dateKey: '2026-07-17', total: 2.5, perMember: { p1: 2.5 } }}
        goal={goal}
        personMap={personMap}
        onClose={() => {}}
      />
    )
    expect(screen.getByText('Creek hike')).toBeInTheDocument()
    expect(screen.queryByText('Old entry')).not.toBeInTheDocument()
  })

  it('falls back to the per-member total breakdown when no recent entry matches (older than the kept log)', () => {
    const goal = makeGoal([])
    render(
      <DayDetailPopover
        dateKey="2026-01-05"
        dayEntry={{ dateKey: '2026-01-05', total: 3, perMember: { p1: 3 } }}
        goal={goal}
        personMap={personMap}
        onClose={() => {}}
      />
    )
    expect(screen.getByText('Wally')).toBeInTheDocument()
    expect(screen.getByText(/kept in the recent log/)).toBeInTheDocument()
  })

  it('shows a quiet empty state for a zero day', () => {
    const goal = makeGoal([])
    render(
      <DayDetailPopover
        dateKey="2026-01-05"
        dayEntry={{ dateKey: '2026-01-05', total: 0, perMember: {} }}
        goal={goal}
        personMap={personMap}
        onClose={() => {}}
      />
    )
    expect(screen.getByText(/No activity logged/)).toBeInTheDocument()
  })
})
