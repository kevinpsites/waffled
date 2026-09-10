import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ServerUnreachableBanner } from './ServerUnreachableBanner'
import { configureReachability, reportNetworkFailure, reportStatus, resetReachability } from '../../lib/api/reachability'

// The device's own link is the other banner's job; stub both halves of it per test.
let deviceOnline = true
let sustainedOffline = false
vi.mock('../../lib/pwa', () => ({ useOnline: () => deviceOnline, useSustainedOffline: () => sustainedOffline }))

function goUnreachable() {
  act(() => {
    reportNetworkFailure()
    reportNetworkFailure()
  })
}

describe('ServerUnreachableBanner', () => {
  beforeEach(() => {
    deviceOnline = true
    sustainedOffline = false
    resetReachability()
    configureReachability({ fetch: vi.fn(async () => ({ status: 503 }) as Response) as unknown as typeof fetch })
  })
  afterEach(() => resetReachability())

  it('shows nothing while the server is answering', () => {
    render(<ServerUnreachableBanner />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('explains the outage and offers a retry once the server stops answering', () => {
    render(<ServerUnreachableBanner />)
    goUnreachable()
    expect(screen.getByRole('status')).toHaveTextContent(/Can’t reach the Waffled server/)
    expect(screen.getByRole('status')).toHaveTextContent(/menu bar and choose Start Waffled/)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('marks the document while it is shown so the app is padded out from under it', () => {
    const root = document.documentElement
    const { unmount } = render(<ServerUnreachableBanner />)
    expect(root.classList.contains('server-unreachable')).toBe(false)

    goUnreachable()
    expect(root.classList.contains('server-unreachable')).toBe(true)
    // jsdom lays nothing out, so this is the fallback height.
    expect(root.style.getPropertyValue('--unreachable-h')).toBe('56px')

    act(() => {
      reportStatus(200)
    })
    expect(root.classList.contains('server-unreachable')).toBe(false)
    expect(root.style.getPropertyValue('--unreachable-h')).toBe('')

    goUnreachable()
    unmount()
    expect(root.classList.contains('server-unreachable')).toBe(false)
  })

  // The device dropping its link hides this strip's story but not the strip: the
  // Offline banner waits out a 10s grace, and a blank top bar for ten seconds was
  // the gap. It keeps the space and changes what it says.
  it('says the device is offline while the offline banner is still holding its breath', () => {
    deviceOnline = false
    render(<ServerUnreachableBanner />)
    goUnreachable()
    expect(screen.getByRole('status')).toHaveTextContent(/offline — reconnecting/)
    expect(screen.queryByRole('button', { name: /Retry|Checking/ })).toBeNull()
    expect(screen.queryByText(/menu bar and choose Start Waffled/)).toBeNull()
  })

  it('stands down once the offline banner takes over', () => {
    deviceOnline = false
    sustainedOffline = true
    render(<ServerUnreachableBanner />)
    goUnreachable()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
