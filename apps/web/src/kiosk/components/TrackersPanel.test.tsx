import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { TrackersPanel } from './TrackersPanel'

const h = vi.hoisted(() => ({
  trackers: [] as unknown[],
  archived: [] as unknown[],
  person: { id: 'me', memberType: 'adult', isAdmin: false } as unknown,
  api: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
    entries: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(),
  },
}))
vi.mock('../../lib/api/trackers', () => ({
  useTrackers: () => ({ trackers: h.trackers, error: null, refresh: () => {} }),
  trackersApi: h.api,
}))
vi.mock('../../lib/api/bus', () => ({ useRefetchOn: () => {}, useLiveRefresh: () => {}, emit: () => {} }))
vi.mock('../../lib/api/persons', () => ({
  useHousehold: () => ({ household: { timezone: 'America/Chicago' }, person: h.person }),
  usePersons: () => ({ persons: [{ id: 'p1', name: 'Ana', avatarEmoji: null, colorHex: null }], loading: false, error: false }),
}))

const tylenol = { id: 't1', title: 'Tylenol', emoji: '💊', askPerson: true, sortOrder: 0, archivedAt: null, lastEntry: null }
const old = { id: 't9', title: 'Old thing', emoji: null, askPerson: false, sortOrder: 1, archivedAt: '2026-01-01T00:00:00Z', lastEntry: null }
const entry = (id: string, personName: string | null, occurredAt = '2026-11-23T20:15:00.000Z') =>
  ({ id, trackerId: 't1', occurredAt, personId: personName ? 'p1' : null, personName, loggedBy: 'me', loggedByName: 'Me', note: null })

beforeEach(() => {
  Object.values(h.api).forEach((f) => f.mockReset())
  h.trackers = [tylenol]
  h.person = { id: 'me', memberType: 'adult', isAdmin: false }
  h.api.list.mockResolvedValue({ trackers: [tylenol, old] })
  h.api.entries.mockResolvedValue({ entries: [entry('e1', null), entry('e2', 'Ana')], nextBefore: null })
  h.api.create.mockResolvedValue({ tracker: tylenol })
  h.api.update.mockResolvedValue({ tracker: tylenol })
  h.api.updateEntry.mockResolvedValue({ entry: entry('e1', null) })
  h.api.deleteEntry.mockResolvedValue({})
})

describe('TrackersPanel', () => {
  it('hides Add/Edit/Archive for a kid', async () => {
    h.person = { id: 'k', memberType: 'child', isAdmin: false }
    render(<TrackersPanel />)
    expect(await screen.findByText('Tylenol')).toBeInTheDocument()
    expect(screen.queryByText('Add tracker')).toBeNull()
    expect(screen.queryByText('Edit')).toBeNull()
    expect(screen.queryByText('Archive')).toBeNull()
  })

  it('creates a tracker through the modal', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('Add tracker'))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Vitamin' } })
    fireEvent.click(screen.getByLabelText(/Ask who it was for/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.api.create).toHaveBeenCalledWith({ title: 'Vitamin', emoji: null, askPerson: true }))
  })

  it('shows archived trackers in a collapsed section with Unarchive', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText(/Archived \(1\)/))
    expect(screen.getByText('Old thing')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Unarchive'))
    await waitFor(() => expect(h.api.update).toHaveBeenCalledWith('t9', { archived: false }))
  })

  it('history shows the person only on entries that have one', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    expect((await screen.findAllByText('Ana')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Someone')).not.toBeInTheDocument()
    expect(screen.getAllByText('Ana').length).toBeGreaterThan(0)
    expect(screen.getAllByText('11/23 2:15 PM').length).toBe(2)
  })

  it('Load more passes nextBefore back verbatim', async () => {
    h.api.entries
      .mockResolvedValueOnce({ entries: [entry('e1', null)], nextBefore: 'opaque/cursor==' })
      .mockResolvedValueOnce({ entries: [entry('e2', 'Ana')], nextBefore: null })
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    fireEvent.click(await screen.findByText('Load more'))
    await waitFor(() => expect(h.api.entries).toHaveBeenLastCalledWith('t1', { personId: undefined, before: 'opaque/cursor==' }))
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull())
    expect(screen.getAllByText('Ana').length).toBeGreaterThan(0)
  })

  it('filters history by person', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    await screen.findAllByLabelText('Delete entry')
    fireEvent.change(screen.getByLabelText('Filter by person'), { target: { value: 'p1' } })
    await waitFor(() => expect(h.api.entries).toHaveBeenLastCalledWith('t1', { personId: 'p1', before: undefined }))
  })

  it('deleting an entry asks first, then calls deleteEntry', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    await screen.findAllByLabelText('Delete entry')
    fireEvent.click(screen.getAllByLabelText('Delete entry')[0])
    expect(h.api.deleteEntry).not.toHaveBeenCalled()
    fireEvent.click(within(document.querySelector('.modal-card') as HTMLElement).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(h.api.deleteEntry).toHaveBeenCalledWith('e1'))
  })

  it('editing the time sends an ISO string, converting from household wall time', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    await screen.findAllByLabelText('Delete entry')
    fireEvent.click(screen.getAllByLabelText('Edit entry time')[0])
    const input = screen.getByLabelText('When') as HTMLInputElement
    expect(input.value).toBe('2026-11-23T14:15')
    fireEvent.change(input, { target: { value: '2026-11-23T15:45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.api.updateEntry).toHaveBeenCalledWith('e1', { occurredAt: '2026-11-23T21:45:00.000Z' }))
  })

  it('delete failure keeps the row and shows an error', async () => {
    h.api.deleteEntry.mockRejectedValue(new Error('500'))
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    await screen.findAllByLabelText('Delete entry')
    fireEvent.click(screen.getAllByLabelText('Delete entry')[0])
    fireEvent.click(within(document.querySelector('.modal-card') as HTMLElement).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't delete/i)
    expect(screen.getAllByLabelText('Delete entry')).toHaveLength(2)
  })

  it('edit failure keeps the modal open with an error', async () => {
    h.api.updateEntry.mockRejectedValue(new Error('500'))
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    await screen.findAllByLabelText('Delete entry')
    fireEvent.click(screen.getAllByLabelText('Edit entry time')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't save/i)
    expect(screen.getByLabelText('When')).toBeInTheDocument()
  })

  it('an invalid edit value shows a message and does not call the API', async () => {
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('History'))
    await screen.findAllByLabelText('Delete entry')
    fireEvent.click(screen.getAllByLabelText('Edit entry time')[0])
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '' } })
    fireEvent.submit(screen.getByLabelText('When').closest('form') as HTMLFormElement)
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid date/i)
    expect(h.api.updateEntry).not.toHaveBeenCalled()
  })

  it('archive failure shows an error instead of an unhandled rejection', async () => {
    h.api.update.mockRejectedValue(new Error('403'))
    render(<TrackersPanel />)
    fireEvent.click(await screen.findByText('Archive'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't archive/i)
  })
})
