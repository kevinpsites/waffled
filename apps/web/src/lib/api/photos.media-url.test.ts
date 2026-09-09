import { nextMediaRefreshDelayMs } from './photos'

describe('signed photo URL refresh cadence', () => {
  it('refreshes halfway through the shortest remaining bearer-URL lifetime', () => {
    const now = 1_700_000_000_000
    const photos = [
      { imageUrl: '/media/h/a.jpg?expires=1700000600&sig=a' },
      { imageUrl: '/media/h/b.jpg?expires=1700000900&sig=b' },
    ]

    expect(nextMediaRefreshDelayMs(photos, now)).toBe(300_000)
  })

  it('uses the ordinary background cadence when no signed local media is present', () => {
    expect(nextMediaRefreshDelayMs([{ imageUrl: 'https://example.com/photo.jpg' }], 0)).toBe(900_000)
  })

  it('retries promptly rather than scheduling an expired URL in the past', () => {
    expect(nextMediaRefreshDelayMs([{ imageUrl: '/media/h/a.jpg?expires=1&sig=a' }], 2_000)).toBe(5_000)
  })
})
