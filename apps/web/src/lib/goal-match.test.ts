import { describe, it, expect } from 'vitest'
import { suggestGoalForEvent, rankGoalSuggestions } from './goal-match'
import type { Goal } from './api'

// Minimal Goal factory — only the fields the matcher reads.
function goal(over: Partial<Goal> & { id: string; title: string }): Goal {
  return {
    id: over.id,
    goalListId: null,
    title: over.title,
    emoji: over.emoji ?? null,
    category: over.category ?? null,
    goalType: over.goalType ?? 'total',
    unit: over.unit ?? null,
    habitPeriod: null,
    habitTargetPerPeriod: null,
    trackingMode: 'shared_total',
    participantMode: over.participantMode ?? 'count_once',
    targetBasis: over.targetBasis ?? 'family',
    logMethod: 'quick_log',
    autoFromCalendar: over.autoFromCalendar ?? true,
    deadline: null,
    isFeatured: false,
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
    participants: over.participants ?? [],
  } as Goal
}

const part = (id: string) => ({ personId: id, name: id, colorHex: null, avatarEmoji: null, target: null, progress: 0 })

describe('suggestGoalForEvent', () => {
  const reading = goal({ id: 'g-read', title: 'Reading hours', category: 'intellectual', participants: [part('kevin')] })
  const outside = goal({ id: 'g-out', title: '1,000 Hours Outside', category: 'physical', participants: [part('kevin'), part('kelly')] })
  const ukulele = goal({ id: 'g-uke', title: 'Learn 5 songs on ukulele', category: 'creative', participants: [part('wally')] })
  const all = [reading, outside, ukulele]

  it('matches a shared concept when the goal title is absent ("Library trip" → Reading)', () => {
    expect(suggestGoalForEvent('Library trip', null, ['kevin'], all)?.id).toBe('g-read')
  })

  it('matches via a goal-title token ("Ukulele lesson" → Learn songs on ukulele)', () => {
    expect(suggestGoalForEvent('Ukulele lesson', null, ['wally'], all)?.id).toBe('g-uke')
  })

  it('matches the outdoors concept ("Morning hike" → 1,000 Hours Outside)', () => {
    expect(suggestGoalForEvent('Morning hike at the park', null, ['kevin'], all)?.id).toBe('g-out')
  })

  it('catches yardwork phrasings ("Mowing the grass" → 1,000 Hours Outside)', () => {
    expect(suggestGoalForEvent('Mowing the grass', null, ['kevin'], all)?.id).toBe('g-out')
    expect(suggestGoalForEvent('Rake the leaves', null, ['kevin'], all)?.id).toBe('g-out')
  })

  it('returns null for an unrelated event ("Dentist appointment")', () => {
    expect(suggestGoalForEvent('Dentist appointment', null, ['kevin'], all)).toBeNull()
  })

  it('does not cross concepts — "Library trip" never matches the parks goal', () => {
    // Both goals are tagged intellectual, but only Reading shares the "reading"
    // concept; the parks goal is "outdoors" so a library trip must not match it.
    const parks = goal({ id: 'g-parks', title: 'Visit 30 state parks', category: 'intellectual', participants: [part('kevin')] })
    expect(suggestGoalForEvent('Library trip', null, ['kevin'], [parks, reading])?.id).toBe('g-read')
  })

  it('respects the participant superset rule', () => {
    // Reading is Kevin-only; an event with Kelly can't map to it.
    expect(suggestGoalForEvent('Library trip', null, ['kevin', 'kelly'], all)).toBeNull()
    // The family Outside goal (Kevin+Kelly) still matches a Kevin+Kelly hike.
    expect(suggestGoalForEvent('Family hike outside', null, ['kevin', 'kelly'], all)?.id).toBe('g-out')
  })

  it('with no attendees, any matching goal is eligible', () => {
    expect(suggestGoalForEvent('Reading time', null, [], all)?.id).toBe('g-read')
  })

  it('ignores goals that are not auto-from-calendar', () => {
    const off = goal({ id: 'g-off', title: 'Reading hours', category: 'intellectual', autoFromCalendar: false, participants: [part('kevin')] })
    expect(suggestGoalForEvent('Library trip', null, ['kevin'], [off])).toBeNull()
  })

  it('stays quiet when two goals tie (ambiguous)', () => {
    // Two reading goals both match "Library trip" only via concept → tie → null.
    const read2 = goal({ id: 'g-read2', title: 'Book club', category: 'intellectual', participants: [part('kevin')] })
    expect(suggestGoalForEvent('Library trip', null, ['kevin'], [reading, read2])).toBeNull()
  })

  it('prefers the stronger (title-token) match over a concept-only one', () => {
    const generic = goal({ id: 'g-phys', title: 'Move more outside', category: 'physical', participants: [part('kevin')] })
    const swim = goal({ id: 'g-swim', title: 'Swim 50 laps', category: 'physical', participants: [part('kevin')] })
    // "Swim at the pool": shares the swimming concept with the swim goal AND its
    // title token "swim" (+10+5); the generic goal shares nothing → swim wins.
    const ranked = rankGoalSuggestions('Swim at the pool', null, ['kevin'], [generic, swim])
    expect(ranked[0].goal.id).toBe('g-swim')
  })

  it('does not false-match on substrings (token-based, not substring)', () => {
    // "kickstart" must not match the art goal via a bare "art" substring.
    const artGoal = goal({ id: 'g-art', title: 'Make art', category: 'creative', participants: [part('kevin')] })
    expect(suggestGoalForEvent('Project kickstart', null, ['kevin'], [artGoal])).toBeNull()
  })
})
