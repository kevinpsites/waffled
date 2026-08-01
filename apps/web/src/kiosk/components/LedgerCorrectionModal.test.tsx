import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LedgerCorrectionModal } from './LedgerCorrectionModal'

const entry = {
  id: '11111111-1111-4111-8111-111111111111', amount: 10, reason: 'spot_award', currency: 'stars',
  detail: null, note: 'Helpful', correctionReason: null, correctionOfId: null,
  reversedById: null, reversible: true, redemptionId: null, createdAt: '2026-07-31T12:00:00Z',
}

function mockApi(calls: Array<{ url: string; body: Record<string, unknown> }>) {
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return { ok: true, status: 201, json: async () => ({ correction: { originalId: entry.id, reversalId: 'r', replacementId: 'c', balance: 4, replayed: false } }) }
  }) as unknown as typeof fetch
}

describe('LedgerCorrectionModal', () => {
  it('writes a reversal and corrected amount with an audit reason', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    mockApi(calls)
    render(<LedgerCorrectionModal target={{ kind: 'entry', entry }} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Replace amount' }))
    fireEvent.change(screen.getByLabelText(/Correct amount/), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Awarded too many stars' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply correction' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].url).toContain(`/api/ledger-entries/${entry.id}/correct`)
    expect(calls[0].body).toMatchObject({ reason: 'Awarded too many stars', replacementAmount: 6 })
    expect(calls[0].body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('uses the dedicated refund endpoint for a settled redemption', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    mockApi(calls)
    render(<LedgerCorrectionModal target={{ kind: 'refund', redemption: {
      id: '22222222-2222-4222-8222-222222222222', title: 'Ice cream', emoji: '🍦', cost: 5,
      currency: 'stars', status: 'approved', ledgerId: entry.id, refundLedgerId: null, createdAt: '2026-07-31T12:00:00Z',
    } }} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Reward was not delivered' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refund reward' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].url).toContain('/api/redemptions/22222222-2222-4222-8222-222222222222/refund')
    expect(calls[0].body).toMatchObject({ reason: 'Reward was not delivered' })
  })
})
