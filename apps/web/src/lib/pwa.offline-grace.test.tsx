import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { OFFLINE_BANNER_GRACE_MS, useSustainedOffline } from './pwa'

// The kiosk's Offline banner must not flash on every blip (PowerSync reconnects,
// network transitions): it only shows after the device has been *continuously*
// offline for the full grace period, and hides immediately on reconnect.

const goOffline = () => window.dispatchEvent(new Event('offline'))
const goOnline = () => window.dispatchEvent(new Event('online'))

describe('useSustainedOffline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('uses a 10 second grace period', () => {
    expect(OFFLINE_BANNER_GRACE_MS).toBe(10_000)
  })

  it('never shows for a blip shorter than the grace period', () => {
    const { result } = renderHook(() => useSustainedOffline())
    expect(result.current).toBe(false)
    act(() => {
      goOffline()
    })
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_GRACE_MS - 1)
    })
    expect(result.current).toBe(false)
    act(() => {
      goOnline()
    })
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_GRACE_MS * 2)
    })
    expect(result.current).toBe(false)
  })

  it('shows once continuously offline for the full grace period', () => {
    const { result } = renderHook(() => useSustainedOffline())
    act(() => {
      goOffline()
    })
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_GRACE_MS - 1)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it('a reconnect cancels the pending show; the next drop restarts the grace', () => {
    const { result } = renderHook(() => useSustainedOffline())
    act(() => {
      goOffline()
    })
    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    act(() => {
      goOnline()
    })
    act(() => {
      goOffline()
    })
    // 12s since the first drop, but only 6s of *continuous* offline — stays hidden.
    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(result.current).toBe(true)
  })

  it('never paints a stale offline frame after reconnect (clears synchronously in render)', () => {
    // Records the value every render pass actually painted — a post-paint-effect
    // clear would paint one extra `true` frame on the render where `online`
    // flips back, which renderHook + act-flushed effects can't see.
    const painted: boolean[] = []
    function Probe() {
      painted.push(useSustainedOffline())
      return null
    }
    render(<Probe />)
    act(() => {
      goOffline()
    })
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_GRACE_MS)
    })
    expect(painted.at(-1)).toBe(true)
    const framesBefore = painted.length
    act(() => {
      goOnline()
    })
    expect(painted.length).toBeGreaterThan(framesBefore)
    // Every render after the reconnect must already read false — same frame.
    expect(painted.slice(framesBefore)).not.toContain(true)
  })

  it('hides promptly when connectivity returns', () => {
    const { result } = renderHook(() => useSustainedOffline())
    act(() => {
      goOffline()
    })
    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_GRACE_MS)
    })
    expect(result.current).toBe(true)
    act(() => {
      goOnline()
    })
    expect(result.current).toBe(false)
  })
})
