// Unit tests for the Capture Tier 2 shared ranking util. Pure function, no DB.
import { describe, it, expect } from 'vitest'
import { rankCandidates } from '../src/modules/capture/candidate-match'

describe('rankCandidates', () => {
  const rows = [
    { id: 'a', title: 'Take out the trash' },
    { id: 'b', title: 'Wash the dishes' },
    { id: 'c', title: 'Trash the junk drawer' },
  ]

  it('ranks an exact normalized title match first at confidence 1', () => {
    const out = rankCandidates('take out the trash', rows)
    expect(out[0].id).toBe('a')
    expect(out[0].confidence).toBe(1)
  })

  it('ranks a partial token-overlap strictly below an exact match', () => {
    const out = rankCandidates('take out the trash', rows)
    const a = out.find((c) => c.id === 'a')!
    const c = out.find((c) => c.id === 'c')!
    expect(a.confidence).toBe(1)
    expect(c).toBeDefined()
    expect(c.confidence).toBeGreaterThan(0)
    expect(c.confidence).toBeLessThan(a.confidence)
    // "Wash the dishes" shares no tokens → dropped below the floor.
    expect(out.find((x) => x.id === 'b')).toBeUndefined()
  })

  it('returns both rows when two are equally good (a tie → 2 candidates)', () => {
    const tie = [
      { id: 'x', title: 'Reading', subtitle: 'Wally' },
      { id: 'y', title: 'Reading', subtitle: 'Lottie' },
    ]
    const out = rankCandidates('reading', tie)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id).sort()).toEqual(['x', 'y'])
    expect(out.every((c) => c.confidence === 1)).toBe(true)
  })

  it('matches on supplied keywords, not only the title', () => {
    const out = rankCandidates('rubbish', [{ id: 'a', title: 'Take out the trash', keywords: ['rubbish', 'garbage'] }])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
  })

  it('returns [] for gibberish with no overlap', () => {
    expect(rankCandidates('qwerty zxcvb', rows)).toEqual([])
  })

  it('returns [] when the description has no usable tokens', () => {
    expect(rankCandidates('the a to for', rows)).toEqual([])
  })

  it('sorts descending by confidence', () => {
    const out = rankCandidates('take out the trash', rows)
    for (let i = 1; i < out.length; i++) expect(out[i - 1].confidence).toBeGreaterThanOrEqual(out[i].confidence)
  })
})
