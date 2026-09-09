import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChoreModal } from './ChoreModal'

function mockApi(opts: { created?: unknown[]; patched?: unknown[]; deleted?: unknown[]; failNextPatch?: boolean }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const m = init?.method
    if (u.includes('/api/persons')) {
      return {
        ok: true,
        json: async () => ({
          persons: [
            { id: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', memberType: 'kid', isAdmin: false },
            { id: 'p2', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0653F', memberType: 'kid', isAdmin: false },
          ],
        }),
      }
    }
    if (u.endsWith('/api/chores') && m === 'POST') {
      opts.created?.push(JSON.parse(init!.body!))
      return { ok: true, json: async () => ({ chore: { id: 'c1' } }) }
    }
    if (/\/api\/chores\/[^/]+$/.test(u) && m === 'PATCH') {
      opts.patched?.push(JSON.parse(init!.body!))
      if (opts.failNextPatch) {
        opts.failNextPatch = false
        return { ok: false, status: 503, json: async () => ({ error: 'temporarily unavailable' }) }
      }
      return { ok: true, json: async () => ({ chore: { id: 'c1' } }) }
    }
    if (/\/api\/chores\/[^/]+$/.test(u) && m === 'DELETE') {
      opts.deleted?.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      return { ok: true, status: 204, json: async () => ({}) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const chore = { id: 'c1', title: 'Old chore', emoji: '🐶', personId: 'p1', rewardAmount: 3 }

describe('ChoreModal', () => {
  it('creates a chore for the prefilled person', async () => {
    const created: unknown[] = []
    mockApi({ created })
    render(<ChoreModal personId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Feed the dog'), { target: { value: 'Tidy room' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ title: 'Tidy room', personId: 'p1' })
  })

  it('edits a chore (PATCH)', async () => {
    const patched: unknown[] = []
    mockApi({ patched })
    render(<ChoreModal chore={chore} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Old chore'), { target: { value: 'New chore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ title: 'New chore' })
  })

  it('canAssignOthers=false restricts the assignee picker to self + up-for-grabs', async () => {
    mockApi({})
    render(<ChoreModal canAssignOthers={false} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByRole('option', { name: /Wally/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /up for grabs/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Lottie/ })).not.toBeInTheDocument()
  })

  it('canAssignOthers=true shows the full member list', async () => {
    mockApi({})
    render(<ChoreModal canAssignOthers={true} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByRole('option', { name: /Wally/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Lottie/ })).toBeInTheDocument()
  })

  it('deletes only after a confirm tap', async () => {
    const deleted: unknown[] = []
    mockApi({ deleted })
    render(<ChoreModal chore={chore} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleted).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete' }))
    await waitFor(() => expect(deleted).toHaveLength(1))
  })

  it('asks for a recurring scope and sends the selected occurrence', async () => {
    const patched: unknown[] = []
    mockApi({ patched })
    render(<ChoreModal chore={{ ...chore, instanceId: 'i1', rrule: 'FREQ=DAILY', dueOn: '2026-07-31', status: 'pending' }} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Old chore'), { target: { value: 'New chore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('dialog', { name: 'Choose recurring chore scope' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'This chore only' }))

    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ title: 'New chore', scope: 'this', instanceId: 'i1' })
  })

  it('does not offer a single occurrence for a repeat-rule change', async () => {
    mockApi({})
    render(<ChoreModal chore={{ ...chore, instanceId: 'i1', rrule: 'FREQ=DAILY', dueOn: '2026-07-31', status: 'pending' }} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Just once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('dialog', { name: 'Choose recurring chore scope' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'This chore only' })).not.toBeInTheDocument()
    expect(screen.getByText(/Repeat changes must apply/)).toBeInTheDocument()
  })

  it.each(['done', 'awaiting'])('does not offer a single-occurrence action for a %s chore', async (status) => {
    mockApi({})
    render(<ChoreModal chore={{ ...chore, instanceId: 'i1', rrule: 'FREQ=DAILY', status }} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Old chore'), { target: { value: 'Future chore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('dialog', { name: 'Choose recurring chore scope' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'This chore only' })).not.toBeInTheDocument()
    expect(screen.getByText(/selected completed or awaiting-approval chore stays unchanged/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This and future chores' })).toBeInTheDocument()
  })

  it('keeps a failed recurring edit visible and retryable', async () => {
    const patched: unknown[] = []
    const onClose = vi.fn()
    mockApi({ patched, failNextPatch: true })
    render(<ChoreModal chore={{ ...chore, instanceId: 'i1', rrule: 'FREQ=DAILY', status: 'pending' }} onClose={onClose} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Old chore'), { target: { value: 'Retry chore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'This and future chores' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/try again/i)
    expect(screen.getByRole('dialog', { name: 'Choose recurring chore scope' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'This and future chores' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(patched).toHaveLength(2)
  })
  // ── What the surface that OPENED the modal gets to decide ────────────────────
  it('a new chore still defaults to Every day, dated by the modal itself', async () => {
    const created: unknown[] = []
    mockApi({ created })
    render(<ChoreModal personId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Every day' }).className).toContain('on')
    fireEvent.change(screen.getByPlaceholderText('Feed the dog'), { target: { value: 'Tidy room' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ rrule: 'FREQ=DAILY' })
    expect((created[0] as { dueOn?: string }).dueOn).toBeUndefined()
  })

  it('takes a starting cadence, day and title from the surface that opened it', async () => {
    const created: unknown[] = []
    mockApi({ created })
    render(
      <ChoreModal
        personId="p1"
        defaultFreq="once"
        defaultDueOn="2099-03-04"
        defaultTitle="Book the sitter"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Just once' }).className).toContain('on')
    expect((screen.getByPlaceholderText('Feed the dog') as HTMLInputElement).value).toBe('Book the sitter')
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ title: 'Book the sitter', rrule: null, dueOn: '2099-03-04' })
  })

  it('hides Delete where removal isn’t on offer', async () => {
    const deleted: unknown[] = []
    mockApi({ deleted })
    render(<ChoreModal chore={chore} canDelete={false} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  // ── The one-off day is editable, not only settable at birth ──────────────────
  it('a one-off shows its own day when edited, and moves it', async () => {
    const patched: unknown[] = []
    mockApi({ patched })
    render(<ChoreModal chore={{ ...chore, dueOn: '2099-03-04' }} onClose={vi.fn()} onSaved={vi.fn()} />)
    const day = screen.getByLabelText('On') as HTMLInputElement
    expect(day.value).toBe('2099-03-04')
    fireEvent.change(day, { target: { value: '2099-03-06' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ dueOn: '2099-03-06' })
  })

  // A carried-over chore is dated in the PAST. Save lives inside a <form>, so a `min` of today
  // would let the browser refuse the submit and make Save look dead; jsdom skips constraint
  // validation, so the attribute assertion is what holds this down.
  it('an already-dated one-off is not floored at today', async () => {
    const patched: unknown[] = []
    mockApi({ patched })
    render(<ChoreModal chore={{ ...chore, dueOn: '2020-01-02' }} onClose={vi.fn()} onSaved={vi.fn()} />)
    const day = screen.getByLabelText('On') as HTMLInputElement
    expect(day.value).toBe('2020-01-02')
    expect(day.hasAttribute('min')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ dueOn: '2020-01-02' })
  })

  it('a new one-off is still floored at today', async () => {
    mockApi({})
    render(<ChoreModal personId="p1" defaultFreq="once" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect((screen.getByLabelText('On') as HTMLInputElement).hasAttribute('min')).toBe(true)
  })

  // A recurring chore's days come from its rrule: there is no single day to move, and the server
  // ignores dueOn for one.
  it('a recurring chore offers no day, and sends none', async () => {
    const patched: unknown[] = []
    mockApi({ patched })
    render(
      <ChoreModal
        chore={{ ...chore, instanceId: 'i1', rrule: 'FREQ=DAILY', dueOn: '2026-07-31', status: 'pending' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('On')).toBeNull()
    fireEvent.change(screen.getByDisplayValue('Old chore'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'This and future chores' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect((patched[0] as { dueOn?: string }).dueOn).toBeUndefined()
  })
})
