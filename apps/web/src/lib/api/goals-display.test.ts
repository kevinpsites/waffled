import { describe, it, expect } from 'vitest'
import { goalDisplayProgress, goalDisplayTarget, goalFraction, fmtGoalNum, type Goal } from './goals'

describe('fmtGoalNum', () => {
  it('rounds to at most 2 decimals, dropping trailing zeros', () => {
    // An hours+minutes log stores exact repeating decimals — never show them raw.
    expect(fmtGoalNum(1 + 5 / 60)).toBe('1.08') // 1h5m
    expect(fmtGoalNum(31 / 12)).toBe('2.58') // 2.5833…
    expect(fmtGoalNum(6.16667)).toBe('6.17')
    expect(fmtGoalNum(2)).toBe('2')
    expect(fmtGoalNum(1.5)).toBe('1.5')
    expect(fmtGoalNum(1000)).toBe('1,000')
    expect(fmtGoalNum(null)).toBe('—')
    expect(fmtGoalNum(undefined)).toBe('—')
  })
})

// Minimal Goal factory — every required field with a sane default, overridable per test.
function goal(over: Partial<Goal>): Goal {
  return {
    id: 'g',
    goalListId: null,
    title: 'G',
    emoji: null,
    category: null,
    goalType: 'total',
    unit: null,
    habitPeriod: null,
    habitTargetPerPeriod: null,
    trackingMode: 'shared_total',
    participantMode: 'count_once',
    targetBasis: 'family',
    logMethod: 'quick_log',
    autoFromCalendar: false,
    deadline: null,
    isFeatured: false,
    isSpotlight: false,
    hasRewards: false,
    target: null,
    totalProgress: 0,
    milestoneTotal: 0,
    milestoneReached: 0,
    periodDone: 0,
    stepTotal: 0,
    stepDone: 0,
    streakDays: 0,
    loggedTodayBy: [],
    participants: [],
    ...over,
  }
}

const twoPeople = [
  { personId: 'p1', name: 'Kevin', colorHex: null, avatarEmoji: null, target: 12, progress: 12 },
  { personId: 'p2', name: 'Kelly', colorHex: null, avatarEmoji: null, target: 12, progress: 12 },
]

describe('goalDisplayTarget / goalDisplayProgress / goalFraction', () => {
  it('per_person each_tracks: target is per-person × members (not the raw target)', () => {
    // "read 12 books each", 2 people, both read 12 → 24 of 24, not 24 of 12.
    const g = goal({ goalType: 'count', targetBasis: 'per_person', target: 12, totalProgress: 24, participants: twoPeople })
    expect(goalDisplayTarget(g)).toBe(24)
    expect(goalDisplayProgress(g)).toBe(24)
    expect(goalFraction(g)).toBe(1) // full, not overflowing past 100%
  })

  it('family basis: target is the flat number', () => {
    const g = goal({ goalType: 'total', targetBasis: 'family', target: 1000, totalProgress: 312 })
    expect(goalDisplayTarget(g)).toBe(1000)
    expect(goalFraction(g)).toBeCloseTo(0.312, 3)
  })

  it('checklist: progress/target are steps, target is never null when there are steps', () => {
    const g = goal({ goalType: 'checklist', target: null, stepTotal: 5, stepDone: 3 })
    expect(goalDisplayProgress(g)).toBe(3)
    expect(goalDisplayTarget(g)).toBe(5)
    expect(goalFraction(g)).toBeCloseTo(0.6, 3)
  })

  it('empty checklist: no positive target → fraction 0 (empty bar), not NaN', () => {
    const g = goal({ goalType: 'checklist', target: null, stepTotal: 0, stepDone: 0 })
    expect(goalDisplayTarget(g)).toBeNull()
    expect(goalFraction(g)).toBe(0)
  })

  it('habit: uses this-period count vs cadence, not the lifetime total/target', () => {
    const g = goal({ goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5, target: 5, periodDone: 2, totalProgress: 99 })
    expect(goalDisplayProgress(g)).toBe(2) // period-done, not the lifetime 99
    expect(goalDisplayTarget(g)).toBe(5) // the cadence
    expect(goalFraction(g)).toBeCloseTo(0.4, 3)
  })
})
