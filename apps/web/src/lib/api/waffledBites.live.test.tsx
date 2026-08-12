import { render, act } from '@testing-library/react'

// The parent control panel used to fetch a device exactly once per mount and
// then never again, so anything the KID did on the device — switching the
// sound machine on, starting a timer, going offline — stayed invisible until
// the page was reloaded. The device polls the server every ~5s, so the
// parent→device direction was live while device→parent never arrived at all.
const get = vi.fn(async () => ({
  device: {
    id: 'dev-1',
    personId: 'p-1',
    settings: { sound: { on: true, sound: 'white', volume: 50, timerMin: 0 } },
  },
}))

vi.mock('./client', () => ({
  apiGet: () => get(),
  apiSend: vi.fn(),
  apiDelete: vi.fn(),
}))

import { emit } from './bus'
import { useWaffledBiteDevice } from './waffledBites'

function Probe({ personId }: { personId: string | null }) {
  const { device } = useWaffledBiteDevice(personId)
  return <div data-testid="sound">{device ? String(device.settings?.sound?.on) : 'none'}</div>
}

describe('useWaffledBiteDevice', () => {
  beforeEach(() => get.mockClear())

  it('keeps polling so device-side changes reach an open parent panel', async () => {
    vi.useFakeTimers()
    try {
      render(<Probe personId="p-1" />)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(get).toHaveBeenCalledTimes(1)

      // A kid taps the sound on. Nothing tells the browser; it has to ask.
      await act(async () => { vi.advanceTimersByTime(11_000) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(get.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling once unmounted, so a closed panel costs nothing', async () => {
    vi.useFakeTimers()
    try {
      const { unmount } = render(<Probe personId="p-1" />)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      unmount()
      const after = get.mock.calls.length
      await act(async () => { vi.advanceTimersByTime(60_000) })
      expect(get.mock.calls.length).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll when there is no device to poll for', async () => {
    vi.useFakeTimers()
    try {
      render(<Probe personId={null} />)
      await act(async () => { vi.advanceTimersByTime(60_000) })
      expect(get).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // The `waffledBites` topic existed in bus.ts from the start but nothing ever
  // emitted it, so a mutation on one surface left the other stale until a poll.
  it('refreshes immediately when a mutation taps the waffledBites topic', async () => {
    render(<Probe personId="p-1" />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(get).toHaveBeenCalledTimes(1)

    await act(async () => { emit('waffledBites') })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(get).toHaveBeenCalledTimes(2)
  })
})
