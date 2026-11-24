import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TrackersCard } from './TrackersCard'

const h = vi.hoisted(() => ({ trackers: [] as unknown[], log: vi.fn(), del: vi.fn() }))
vi.mock('../../lib/api/trackers', () => ({
  useTrackers: () => ({ trackers: h.trackers, error: null, refresh: () => {} }),
  trackersApi: { log: h.log, deleteEntry: h.del },
}))
vi.mock('../../lib/api/persons', () => ({
  useHousehold: () => ({ household: { timezone: 'America/New_York' } }),
  usePersons: () => ({ persons: [{ id: 'p1', name: 'Ana', avatarEmoji: null, colorHex: null }], loading: false, error: false }),
}))

const tylenol = { id: 't1', title: 'Tylenol', emoji: '💊', askPerson: false, lastEntry: { id: 'e0', occurredAt: '2026-11-23T19:15:00.000Z', personId: null, personName: null } }
const vit = { id: 't2', title: 'Vitamin', emoji: null, askPerson: true, lastEntry: null }

beforeEach(() => {
  h.log.mockReset().mockResolvedValue({ entry: { id: 'new1' } })
  h.del.mockReset().mockResolvedValue({})
  h.trackers = [tylenol, vit]
})

describe('TrackersCard', () => {
  it('renders a tile per tracker with last-time text', () => {
    render(<TrackersCard />)
    expect(screen.getByText('Tylenol')).toBeInTheDocument()
    expect(screen.getByText('Last time: 11/23 2:15 PM')).toBeInTheDocument()
    expect(screen.getByText('Not logged yet')).toBeInTheDocument()
  })

  it('logs a plain tracker on tap and offers Undo', async () => {
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    expect(await screen.findByText('Logged Tylenol')).toBeInTheDocument()
    expect(h.log).toHaveBeenCalledWith('t1', {})
    fireEvent.click(screen.getByText('Undo'))
    expect(h.del).toHaveBeenCalledWith('new1')
  })

  it('Undo of an already-deleted entry (404) dismisses quietly', async () => {
    h.del.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    fireEvent.click(await screen.findByText('Undo'))
    await waitFor(() => expect(screen.queryByText('Logged Tylenol')).not.toBeInTheDocument())
    expect(screen.queryByText(/Undo didn't go through/)).not.toBeInTheDocument()
  })

  it('Undo that fails for any other reason says so', async () => {
    h.del.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    fireEvent.click(await screen.findByText('Undo'))
    expect(await screen.findByText(/Undo didn't go through/)).toBeInTheDocument()
  })

  it('Undo that fails on the network says so', async () => {
    h.del.mockRejectedValue(new TypeError('network'))
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    fireEvent.click(await screen.findByText('Undo'))
    expect(await screen.findByText(/Undo didn't go through/)).toBeInTheDocument()
  })

  it('ignores taps on a tile while its log is in flight, then logs again once it returns', async () => {
    let resolve!: (v: unknown) => void
    h.log.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    fireEvent.click(screen.getByText('Tylenol'))
    expect(h.log).toHaveBeenCalledTimes(1)
    resolve({ entry: { id: 'a' } })
    await screen.findByText('Logged Tylenol')
    fireEvent.click(screen.getByText('Tylenol'))
    await waitFor(() => expect(h.log).toHaveBeenCalledTimes(2))
  })

  it('an open picker counts as in flight until cancelled', () => {
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Vitamin'))
    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.click(screen.getByText('Vitamin'))
    expect(screen.getByText('Ana')).toBeInTheDocument()
  })

  it('double tap logs twice and Undo deletes only the latest', async () => {
    h.log.mockResolvedValueOnce({ entry: { id: 'a' } }).mockResolvedValueOnce({ entry: { id: 'b' } })
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    await screen.findByText('Undo')
    fireEvent.click(screen.getByText('Tylenol'))
    await waitFor(() => expect(h.log).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByText('Undo'))
    expect(h.del).toHaveBeenCalledTimes(1)
    expect(h.del).toHaveBeenCalledWith('b')
  })

  it('askPerson opens the picker; picking logs with personId', async () => {
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Vitamin'))
    fireEvent.click(screen.getByText('Ana'))
    await waitFor(() => expect(h.log).toHaveBeenCalledWith('t2', { personId: 'p1' }))
  })

  it('cancelling the picker logs nothing', () => {
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Vitamin'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(h.log).not.toHaveBeenCalled()
    expect(screen.queryByText('Ana')).not.toBeInTheDocument()
  })

  it('shows an inline error when logging fails', async () => {
    h.log.mockRejectedValue(new Error('x'))
    render(<TrackersCard />)
    fireEvent.click(screen.getByText('Tylenol'))
    expect(await screen.findByText(/didn't go through/)).toBeInTheDocument()
    expect(screen.queryByText('Logged Tylenol')).not.toBeInTheDocument()
  })

  it('renders nothing with no trackers', () => {
    h.trackers = []
    const { container } = render(<TrackersCard />)
    expect(container).toBeEmptyDOMElement()
  })
})
