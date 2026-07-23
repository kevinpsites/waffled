import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CountdownEditModal } from './CountdownEditModal'
import type { Countdown } from '../../lib/api'

const cd: Countdown = {
  id: 'c1', title: 'Disney', date: '2026-08-02', daysLeft: 12,
  source: 'standalone', emoji: '🎢', color: null, personId: null,
}

interface Sent { method: string; url: string; body: any }
function mock(sent: Sent[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('CountdownEditModal', () => {
  it('renames a standalone countdown (PATCH /api/countdowns/:id)', async () => {
    const sent: Sent[] = []
    mock(sent)
    const onClose = vi.fn()
    render(<CountdownEditModal countdown={cd} onClose={onClose} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Disney Trip' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH')!
    expect(patch.url).toMatch(/\/api\/countdowns\/c1$/)
    expect(patch.body).toMatchObject({ title: 'Disney Trip', date: '2026-08-02' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('removes a standalone countdown (DELETE /api/countdowns/:id)', async () => {
    const sent: Sent[] = []
    mock(sent)
    render(<CountdownEditModal countdown={cd} onClose={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(sent.some((s) => s.method === 'DELETE' && /\/api\/countdowns\/c1$/.test(s.url))).toBe(true)
    )
  })
})
