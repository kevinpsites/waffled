import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ServerUnreachableBanner } from './ServerUnreachableBanner'
import { configureReachability, reportNetworkFailure, reportStatus, resetReachability } from '../../lib/api/reachability'

// The device's own link is the other banner's job; stub it per test.
let deviceOnline = true
vi.mock('../../lib/pwa', () => ({ useOnline: () => deviceOnline }))

function goUnreachable() {
  act(() => {
    reportNetworkFailure()
    reportNetworkFailure()
  })
}

describe('ServerUnreachableBanner', () => {
  beforeEach(() => {
    deviceOnline = true
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

  it('stays hidden when the device itself is offline — that banner wins', () => {
    deviceOnline = false
    render(<ServerUnreachableBanner />)
    goUnreachable()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
