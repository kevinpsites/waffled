import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SyncHealthBanner } from './SyncHealthBanner'
import { publishSyncHealth, __resetSyncHealthForTests, type SyncHealthSnapshot } from '../../lib/powersync/sync-health'

const base: Omit<SyncHealthSnapshot, 'status'> = { hasSynced: true, lastSyncedAt: 1, restartCount: 0, lastRestartAt: null }

beforeEach(() => {
  __resetSyncHealthForTests()
})

describe('SyncHealthBanner', () => {
  // Everything except a stall is either normal or already has its own banner —
  // shouting about a five-second WASM boot would train people to ignore it.
  it('renders nothing while sync is off, healthy, starting, connecting, or plain offline', () => {
    for (const status of ['off', 'ok', 'starting', 'connecting', 'offline', 'no-auth'] as const) {
      const { unmount } = render(<SyncHealthBanner />)
      act(() => publishSyncHealth({ status, ...base }))
      expect(document.querySelector('.sync-banner')).toBeNull()
      unmount()
    }
  })

  it('appears when the engine stalls and clears again on recovery', () => {
    render(<SyncHealthBanner />)
    act(() => publishSyncHealth({ status: 'stalled', ...base, restartCount: 1, lastRestartAt: 2 }))
    expect(screen.getByRole('status')).toHaveClass('sync-banner')
    act(() => publishSyncHealth({ status: 'ok', ...base, restartCount: 1, lastRestartAt: 2 }))
    expect(document.querySelector('.sync-banner')).toBeNull()
  })

  // While stalled the data hooks fall back to REST, so what's on screen IS
  // current — the banner must say that rather than imply the data is stale.
  it('reassures that the data on screen is still coming from the server', () => {
    render(<SyncHealthBanner />)
    act(() => publishSyncHealth({ status: 'stalled', ...base }))
    expect(screen.getByRole('status').textContent).toMatch(/server/i)
  })
})
