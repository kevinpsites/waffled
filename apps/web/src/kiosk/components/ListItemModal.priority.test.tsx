import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ListItemModal } from './ListItemModal'
import type { ListItem, Person } from '../../lib/api'

const persons: Person[] = [{ id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED', memberType: 'adult', isAdmin: true }]

interface Sent { method: string; url: string; body: any }

function mock(sent: Sent[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
    return { ok: true, json: async () => ({ item: { id: 'i1', name: 'Passport', priority: 2 } }) }
  }) as unknown as typeof fetch
}

const item: ListItem = {
  id: 'i1', name: 'Passport', quantity: null, checked: false, checkedAt: null,
  section: 'Docs', priority: 0, sortOrder: 0, assignee: null,
}

describe('ListItemModal — priority', () => {
  it('preselects the item\'s current priority and PATCHes a new one', async () => {
    const sent: Sent[] = []
    mock(sent)
    render(<ListItemModal listId="L" item={item} persons={persons} sections={['Docs']} onClose={() => {}} onSaved={() => {}} />)

    // choose Urgent, then save
    fireEvent.click(screen.getByRole('button', { name: /Urgent/i }))
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH')!
    expect(patch.body).toMatchObject({ priority: 2 })
  })
})
