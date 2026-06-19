// Unit test for the server-side keyword/concept matcher (no DB).
import { describe, it, expect } from 'vitest'
import { keywordMatch, tokensOf } from '../src/modules/goals/goal-match'

const reading = { id: 'g-read', title: 'Reading hours' }
const outside = { id: 'g-out', title: '1,000 Hours Outside' }
const ukulele = { id: 'g-uke', title: 'Learn 5 songs on ukulele' }
const all = [reading, outside, ukulele]

describe('keywordMatch (server)', () => {
  it('matches a shared concept ("Library trip" → Reading)', () => {
    expect(keywordMatch('Library trip', null, all)).toBe('g-read')
  })
  it('matches the expanded outdoors net ("Mowing the grass" → Outside)', () => {
    expect(keywordMatch('Mowing the grass', null, all)).toBe('g-out')
  })
  it('matches a goal-title token ("Ukulele lesson" → ukulele goal)', () => {
    expect(keywordMatch('Ukulele lesson', null, all)).toBe('g-uke')
  })
  it('returns null for an unrelated event', () => {
    expect(keywordMatch('Dentist appointment', null, all)).toBeNull()
  })
  it('stays quiet on a tie (two reading goals)', () => {
    const books = { id: 'g-books', title: 'Read 20 books' }
    expect(keywordMatch('Library trip', null, [reading, books])).toBeNull()
  })
})

describe('tokensOf', () => {
  it('drops stopwords/units/numbers and stems (crude stem: grass→gras, both sides)', () => {
    expect(tokensOf('Mowing the grass for 2 hours').sort()).toEqual(['gras', 'mow'])
  })
})
