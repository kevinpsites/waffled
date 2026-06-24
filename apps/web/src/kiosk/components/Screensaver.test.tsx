import { render, act } from '@testing-library/react'
import { Screensaver, screensaverPhotos } from './Screensaver'
import type { Photo } from '../../lib/api'

function makePhoto(over: Partial<Photo>): Photo {
  return {
    id: 'p',
    imageUrl: 'http://x/img.jpg',
    caption: 'cap',
    emoji: null,
    colorHex: '#7fc1e8',
    memory: null,
    takenAt: null,
    isFavorite: false,
    reactions: {},
    uploadedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const all: Photo[] = [
  makePhoto({ id: 'a', isFavorite: true, memory: 'Lake Day' }),
  makePhoto({ id: 'b', isFavorite: false, memory: 'Lake Day' }),
  makePhoto({ id: 'c', isFavorite: true, memory: 'Birthday' }),
  makePhoto({ id: 'd', isFavorite: false, memory: null }),
]

describe('screensaverPhotos', () => {
  it('returns all photos for "all"/default and never mutates input', () => {
    const out = screensaverPhotos(all, { photoSource: 'all' })
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(out).not.toBe(all)
    // default (no source) → all
    expect(screensaverPhotos(all, {}).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('filters to favorites', () => {
    expect(screensaverPhotos(all, { photoSource: 'favorites' }).map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('filters to a specific album (and falls back to all when no album set)', () => {
    expect(screensaverPhotos(all, { photoSource: 'album', photoAlbum: 'Lake Day' }).map((p) => p.id)).toEqual(['a', 'b'])
    expect(screensaverPhotos(all, { photoSource: 'album', photoAlbum: null }).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('shuffle keeps the same elements and length, without mutating input', () => {
    const before = all.map((p) => p.id)
    const out = screensaverPhotos(all, { photoSource: 'all', photoShuffle: true })
    expect(out).toHaveLength(all.length)
    expect([...out.map((p) => p.id)].sort()).toEqual([...before].sort())
    expect(all.map((p) => p.id)).toEqual(before) // input untouched
  })
})

describe('Screensaver photo cycling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('advances the photo on the provided intervalSeconds', () => {
    const photos = [makePhoto({ id: 'a', imageUrl: 'http://x/a.jpg' }), makePhoto({ id: 'b', imageUrl: 'http://x/b.jpg' })]
    const { container } = render(
      <Screensaver content="photos" photos={photos} weather={null} nextEvent={null} intervalSeconds={5} onWake={() => {}} />,
    )
    // the top (incoming) layer reflects the current photo; the base is the outgoing one
    const src = () => container.querySelector('img.ph-saver-img-top')?.getAttribute('src')
    const first = src()
    // Before the interval elapses, still the first photo.
    act(() => { vi.advanceTimersByTime(4000) })
    expect(src()).toBe(first)
    // After 5s, it advances.
    act(() => { vi.advanceTimersByTime(1500) })
    expect(src()).not.toBe(first)
  })

  it('bare mode shows photos but hides the clock/weather chrome', () => {
    const photos = [makePhoto({ id: 'a', imageUrl: 'http://x/a.jpg', memory: 'Lake Day' })]
    const { container, rerender } = render(
      <Screensaver content="photos" photos={photos} weather={null} nextEvent={null} bare onWake={() => {}} />,
    )
    expect(container.querySelector('.ph-saver-img-top')).toBeTruthy()
    expect(container.querySelector('.ph-saver-clock')).toBeNull()
    expect(container.querySelector('.ph-saver-meta')).toBeNull()

    // …and the chrome IS present when not bare
    rerender(<Screensaver content="photos" photos={photos} weather={null} nextEvent={null} onWake={() => {}} />)
    expect(container.querySelector('.ph-saver-clock')).toBeTruthy()
  })
})
