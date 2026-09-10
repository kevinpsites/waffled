import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AuthGate } from './AuthGate'
import { SERVER_PROBE_EVENT, resetReachability } from '../lib/api/reachability'

// With the server stopped, /api/auth/status never answers. Rendering the login form
// then would offer a sign-in nobody can complete, with nothing saying why.
describe('AuthGate when the server does not answer', () => {
  beforeEach(() => resetReachability())
  afterEach(() => {
    // A leaked offline device would disable outage detection for every later spec.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    resetReachability()
    vi.restoreAllMocks()
  })

  const gate = () => (
    <MemoryRouter>
      <AuthGate>
        <div>the app</div>
      </AuthGate>
    </MemoryRouter>
  )

  it('shows the unreachable screen on the very first failed status call', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    render(gate())

    expect(await screen.findByText(/Can’t reach the Waffled server/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).toBeNull()
    // The banner above this card owns the Retry and the how-to-start-it hint; the
    // card telling the same story twice was the whole problem.
    expect(screen.queryByRole('button', { name: /Retry|Checking/ })).toBeNull()
    expect(screen.queryByText(/menu bar and choose Start Waffled/)).toBeNull()
  })

  it('blames the device, not the server, when the device itself is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    render(gate())

    expect(await screen.findByText(/Your device is offline/)).toBeInTheDocument()
    expect(screen.queryByText(/menu bar and choose Start Waffled/)).toBeNull()
  })

  it('falls back to the login screen when the server answers with an error', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch

    render(gate())

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(screen.queryByText(/Can’t reach the Waffled server/)).toBeNull()
  })

  it('keeps checking on its own and leaves as soon as the server answers', async () => {
    vi.useFakeTimers()
    try {
      let answering = false
      globalThis.fetch = vi.fn(async () => {
        if (!answering) throw new TypeError('Failed to fetch')
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ initialized: true, methods: ['password'] }),
        }
      }) as unknown as typeof fetch

      render(gate())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/Can’t reach the Waffled server/)).toBeInTheDocument()

      // Nobody touched Retry — the store's own probe (3s grace, then 5s) reports back.
      answering = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })
      expect(screen.getByLabelText('Email')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the probe cadence to the store instead of running its own', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      render(gate())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/Can’t reach the Waffled server/)).toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledTimes(1) // the status call itself

      // The store admits the outage at its 3s grace and probes 5s later, then every 5s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)

      // A minute in, the cadence backs off to 15s — the screen doesn't hold it at 5s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50_000)
      })
      const atBackoff = fetchMock.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000)
      })
      expect(fetchMock).toHaveBeenCalledTimes(atBackoff)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(fetchMock).toHaveBeenCalledTimes(atBackoff + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves on an answered probe and takes its listener with it', async () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    const { unmount } = render(gate())
    expect(await screen.findByText(/Can’t reach the Waffled server/)).toBeInTheDocument()

    const count = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === SERVER_PROBE_EVENT).length
    expect(count(added)).toBe(1)
    expect(count(removed)).toBe(0)

    unmount()
    expect(count(removed)).toBe(1)
  })

  it('leaves the screen when a probe answers, even with no store transition', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('Failed to fetch')
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ initialized: true, methods: ['password'] }),
      }
    }) as unknown as typeof fetch

    render(gate())
    expect(await screen.findByText(/Can’t reach the Waffled server/)).toBeInTheDocument()

    // One failure is still inside the store's grace window, so it never went
    // unreachable and there is no recovery event — the probe's own verdict is all
    // this screen gets.
    act(() => {
      window.dispatchEvent(new CustomEvent(SERVER_PROBE_EVENT, { detail: { answered: true } }))
    })
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  })
})
