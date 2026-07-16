import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { ParsedIntent } from '../../lib/capture/parse'

// Tier 2 mutate flow: a SERVER-parsed mutate intent (verb + targetKind) drives a
// candidate picker (/api/capture/resolve), and a chosen candidate commits via
// /api/capture/commit. We mock the api module so the hooks + capture methods are
// deterministic; the real parseCapture heuristic still runs underneath.
const { resolve, resolveCandidates, commitMutate, warm, lists } = vi.hoisted(() => ({
  resolve: vi.fn(),
  resolveCandidates: vi.fn(),
  commitMutate: vi.fn(),
  warm: vi.fn(),
  lists: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    usePersons: () => ({
      persons: [{ id: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }],
      loading: false,
      error: false,
    }),
    useHousehold: () => ({
      household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' },
      person: { id: 'p9', name: 'Kev', isAdmin: true, capabilities: [] },
      memberships: [],
      pendingInvites: [],
    }),
    can: () => true,
    api: { ...actual.api, resolve, resolveCandidates, commitMutate, warm, lists },
  }
})

import { CaptureBar } from './CaptureBar'

const mutateIntent = (verb: string, targetKind: string, description: string): ParsedIntent =>
  ({ kind: 'mutate', verb, targetKind, target: { description }, args: {} } as unknown as ParsedIntent)

function openAndType(value: string) {
  fireEvent.click(document.querySelector('.capture-trigger') as HTMLElement)
  const ta = screen.getByLabelText('Add anything') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value } })
}

beforeEach(() => {
  resolve.mockReset()
  resolveCandidates.mockReset()
  commitMutate.mockReset()
  warm.mockReset().mockResolvedValue(undefined)
  lists.mockReset().mockResolvedValue({ lists: [] })
})

describe('CaptureBar — Tier 2 mutate picker', () => {
  it('renders candidate chips and commits the picked id (2+ candidates)', async () => {
    resolve.mockResolvedValue({ intent: mutateIntent('complete', 'chore', 'trash chore'), via: 'anthropic' })
    resolveCandidates.mockResolvedValue({
      candidates: [
        { id: 'ci1', title: 'Take out the trash', subtitle: 'Wally · pending', confidence: 0.9 },
        { id: 'ci2', title: 'Empty the recycling', subtitle: 'George · pending', confidence: 0.5 },
      ],
    })
    commitMutate.mockResolvedValue({ ok: true, message: 'Marked “Take out the trash” done' })

    // An open chores view refetches off the 'chores' bus topic — assert the commit fires it.
    const choresRefreshed = vi.fn()
    window.addEventListener('waffled:chores', choresRefreshed)

    render(<CaptureBar />)
    openAndType('mark the trash chore done')

    await waitFor(() => expect(screen.getByText(/Take out the trash/)).toBeInTheDocument(), { timeout: 3000 })
    // 2+ candidates → nothing auto-selected; pick the first, then confirm.
    fireEvent.click(screen.getByText(/Take out the trash/))
    const confirm = await screen.findByRole('button', { name: /mark done/i })
    fireEvent.click(confirm)

    await waitFor(() => expect(commitMutate).toHaveBeenCalled())
    await waitFor(() => expect(choresRefreshed).toHaveBeenCalled())
    window.removeEventListener('waffled:chores', choresRefreshed)
    expect(commitMutate).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'complete', targetKind: 'chore', targetId: 'ci1' }),
    )
    await waitFor(() => expect(screen.getByText(/Marked/)).toBeInTheDocument())
  })

  it('still resolves when the parse is on-device (no LLM configured — online, not offline)', async () => {
    // A household with no AI provider: /api/capture defers, so api.resolve falls back to the
    // on-device heuristic and returns the mutate marker with via 'on-device'. The mutate must
    // STILL hit /resolve — it must NOT be blocked as "I need a connection for that."
    resolve.mockResolvedValue({ intent: mutateIntent('complete', 'chore', 'trash chore'), via: 'on-device' })
    resolveCandidates.mockResolvedValue({
      candidates: [{ id: 'ci1', title: 'Take out the trash', subtitle: 'Wally · pending', confidence: 1 }],
    })
    commitMutate.mockResolvedValue({ ok: true, message: 'Marked “Take out the trash” done' })

    render(<CaptureBar />)
    openAndType('mark the trash chore done')

    await waitFor(() => expect(resolveCandidates).toHaveBeenCalled(), { timeout: 3000 })
    expect(resolveCandidates).toHaveBeenCalledWith(expect.objectContaining({ verb: 'complete', targetKind: 'chore' }))
    expect(await screen.findByText(/Take out the trash/)).toBeInTheDocument()
    expect(screen.queryByText(/I need a connection/i)).not.toBeInTheDocument()
    // ...and it plainly tells the user an AI key gives reliable results.
    expect(screen.getByText(/Add an AI provider/i)).toBeInTheDocument()
  })

  it('shows a not-found state with the disabledReason (0 candidates)', async () => {
    resolve.mockResolvedValue({ intent: mutateIntent('complete', 'chore', 'laundry'), via: 'anthropic' })
    resolveCandidates.mockResolvedValue({ candidates: [], disabledReason: 'Chores is turned off' })

    render(<CaptureBar />)
    openAndType('mark the laundry chore done')

    await waitFor(() => expect(screen.getByText(/Couldn.t find a chore/i)).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText(/Chores is turned off/)).toBeInTheDocument()
    expect(commitMutate).not.toHaveBeenCalled()
  })

  it('forces an explicit destructive confirm for delete (↵ disabled; only the Delete button commits)', async () => {
    resolve.mockResolvedValue({ intent: mutateIntent('delete', 'event', 'dentist appointment'), via: 'anthropic' })
    resolveCandidates.mockResolvedValue({
      candidates: [{ id: 'ev1', title: 'Dentist', subtitle: 'Fri 4pm', confidence: 0.95, meta: { seriesScopeOnly: true } }],
    })
    commitMutate.mockResolvedValue({ ok: true, message: 'Deleted “Dentist”' })

    render(<CaptureBar />)
    openAndType('delete the dentist appointment')

    // Single candidate auto-selected, but the ↵ submit stays disabled — delete needs
    // the explicit destructive button.
    const del = await screen.findByRole('button', { name: /delete it/i }, { timeout: 3000 })
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    fireEvent.click(del)
    await waitFor(() => expect(commitMutate).toHaveBeenCalled())
    expect(commitMutate).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'delete', targetKind: 'event', targetId: 'ev1', meta: { seriesScopeOnly: true } }),
    )
  })
})
