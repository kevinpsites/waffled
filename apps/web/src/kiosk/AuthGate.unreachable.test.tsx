import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AuthGate } from './AuthGate'
import { resetReachability } from '../lib/api/reachability'

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

  it('re-resolves to the login screen once a retry reaches the server', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    render(gate())
    await screen.findByText(/Can’t reach the Waffled server/)

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ initialized: true, methods: ['password'] }),
    })) as unknown as typeof fetch
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  })
})
