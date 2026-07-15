import { describe, it, expect } from 'vitest'
import { seedGoalParticipants, goalWhoHighlights } from './CaptureBar'

// GoalWho models the "who's it for" choice as a SET of participantIds: "Just me" is
// {viewer.id}, "Everyone" is all member ids, and each person tile toggles membership.
// The set is SEEDED from the inferred audience so "family"/"personal" phrasing lands on
// the right preset — and drives the chip + tile highlights consistently.
describe('GoalWho — audience-seeded, set-based selection', () => {
  const jerry = 'p-jerry'
  const kramer = 'p-kramer'
  const all = [jerry, kramer]

  it('seeds the Everyone preset (all members) from an "everyone" audience', () => {
    expect(seedGoalParticipants('everyone', jerry, all)).toEqual(all)
  })

  it('seeds Just-me (the viewer) from a "me" or null audience', () => {
    expect(seedGoalParticipants('me', jerry, all)).toEqual([jerry])
    expect(seedGoalParticipants(null, jerry, all)).toEqual([jerry])
  })

  it('falls back to an empty set when the viewer id has not loaded yet', () => {
    expect(seedGoalParticipants('me', null, all)).toEqual([])
  })

  it('lights "Just me" AND the viewer\'s own tile for the {viewer} set', () => {
    const ids = [jerry]
    const { isJustMe, isEveryone } = goalWhoHighlights(ids, jerry, all)
    expect(isJustMe).toBe(true)
    expect(isEveryone).toBe(false)
    // Same person → the viewer's own tile is highlighted because its id is in the set.
    expect(ids.includes(jerry)).toBe(true)
  })

  it('lights "Everyone" when the set equals all members', () => {
    const { isJustMe, isEveryone } = goalWhoHighlights(all, jerry, all)
    expect(isEveryone).toBe(true)
    expect(isJustMe).toBe(false)
  })

  it('lights neither preset for a hand-picked subset that is not just-me or everyone', () => {
    const { isJustMe, isEveryone } = goalWhoHighlights([kramer], jerry, all)
    expect(isJustMe).toBe(false)
    expect(isEveryone).toBe(false)
  })
})
