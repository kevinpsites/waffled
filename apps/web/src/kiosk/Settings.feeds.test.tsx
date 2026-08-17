import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { CalendarFeedsCard } from './Settings'

// "Private" on a feed means "only the person it belongs to sees it". A private feed
// that belongs to NOBODY is therefore a feed nobody can see: its events import with
// owner_person_id = NULL, and the read filter (`visibility = 'family' or
// owner_person_id = $viewer`) never matches NULL — not even for the admin who added
// it. Nothing looks wrong either: the feed syncs green with real import counts.
//
// The API refuses the combination outright; the UI's job is to make sure nobody can
// ask for it in the first place.

const persons = [{ id: 'p1', name: 'Wally', colorHex: '#abc', avatarEmoji: null }]

function feed(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    url: 'https://example.com/school.ics',
    name: 'School calendar',
    personId: null,
    personName: null,
    visibility: 'family',
    lastSyncedAt: null,
    lastError: null,
    ...over,
  }
}

let patched: Array<Record<string, unknown>> = []

beforeEach(() => {
  patched = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons }) }
    if (u.includes('/api/calendar/feeds')) {
      if (init?.body) patched.push(JSON.parse(String(init.body)))
      return { ok: true, json: async () => ({ feed: feed() }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

describe('Calendar feeds — private needs a person', () => {
  it('does not offer Private while the feed belongs to nobody', async () => {
    render(<CalendarFeedsCard feeds={[feed() as never]} onChanged={() => {}} />)

    await screen.findByText('School calendar')
    expect(screen.queryByRole('checkbox', { name: /Private feed/i })).toBeNull()
  })

  it('offers Private once the feed belongs to someone', async () => {
    render(<CalendarFeedsCard feeds={[feed({ personId: 'p1', personName: 'Wally' }) as never]} onChanged={() => {}} />)

    await screen.findByText('School calendar')
    expect(await screen.findByRole('checkbox', { name: /Private feed/i })).toBeInTheDocument()
  })

  // Unassigning is the other way in: the feed is already private, and taking its
  // person away would strand it without the word "private" being touched. Sharing it
  // back with the family is the only sensible reading of "belongs to nobody".
  it('shares a private feed back with the family when its person is removed', async () => {
    render(
      <CalendarFeedsCard
        feeds={[feed({ personId: 'p1', personName: 'Wally', visibility: 'personal' }) as never]}
        onChanged={() => {}}
      />
    )

    await screen.findByText('School calendar')
    fireEvent.change(screen.getByRole('combobox', { name: /Person for feed/i }), { target: { value: '' } })

    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ personId: null, visibility: 'family' })
  })
})
