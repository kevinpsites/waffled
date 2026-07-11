import { describe, it, expect } from 'vitest'
import { measureCountingFields } from './GoalCreate'

// Switching the measure must re-normalize the counting fields so a measure-specific
// sub-choice (a total's "split") can't survive onto another type and submit fractional
// per-person data on a whole-number count goal. Mirrors iOS selectMeasure.
describe('measureCountingFields', () => {
  it('drops a total "split" when switching to Count — never leaves participantMode:split', () => {
    // total + "Split across who took part" = shared_total + split
    const next = measureCountingFields({ goalType: 'total', trackingMode: 'shared_total', targetBasis: 'family' }, 'count')
    expect(next.participantMode).toBe('count_once') // the stale 'split' is gone
    expect(next.trackingMode).toBe('each_tracks')
    expect(next.targetBasis).toBe('family')
  })

  it('preserves the "each tracks their own" (per-person) intent across a switch', () => {
    const next = measureCountingFields({ goalType: 'total', trackingMode: 'each_tracks', targetBasis: 'per_person' }, 'count')
    expect(next).toEqual({ trackingMode: 'each_tracks', targetBasis: 'per_person', participantMode: 'count_once' })
  })

  it('a plain shared total → count keeps the shared "everyone counts" default', () => {
    const next = measureCountingFields({ goalType: 'total', trackingMode: 'each_tracks', targetBasis: 'family' }, 'count')
    expect(next).toEqual({ trackingMode: 'each_tracks', targetBasis: 'family', participantMode: 'count_once' })
  })

  it('switching to a habit yields a valid non-per-person combo', () => {
    const next = measureCountingFields({ goalType: 'count', trackingMode: 'each_tracks', targetBasis: 'per_person' }, 'habit')
    expect(next.trackingMode).toBe('each_tracks')
    expect(next.targetBasis).toBe('family') // per_person is total/count-only
    expect(next.participantMode).toBe('count_once')
  })
})
