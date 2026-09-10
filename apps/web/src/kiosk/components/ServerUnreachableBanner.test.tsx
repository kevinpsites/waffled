import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ServerUnreachableBanner } from './ServerUnreachableBanner'
import { configureReachability, reportNetworkFailure, resetReachability } from '../../lib/api/reachability'

// The device's own link is the other banner's job; stub it per test.
let deviceOffline = false
vi.mock('../../lib/pwa', () => ({ useSustainedOffline: () => deviceOffline }))

function goUnreachable() {
  act(() => {
    reportNetworkFailure()
    reportNetworkFailure()
  })
}

describe('ServerUnreachableBanner', () => {
  beforeEach(() => {
    deviceOffline = false
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

  it('stays hidden when the device itself is offline — that banner wins', () => {
    deviceOffline = true
    render(<ServerUnreachableBanner />)
    goUnreachable()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
