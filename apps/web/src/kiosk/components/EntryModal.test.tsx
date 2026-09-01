import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EntryModal } from './EntryModal'
import type { Goal, GoalLogEntry } from '../../lib/api'

// Editing a logged entry used to quietly move it to another day. The date field was
// seeded by re-parsing `loggedAt` (a UTC instant) in the browser, so an evening log
// in a behind-UTC household read as *tomorrow* — and `loggedOn` is sent on every
// save. The note was written, then the entry vanished from the day you were looking
// at, which is indistinguishable from "the note didn't save".

interface Sent { method: string; url: string; body: Record<string, unknown> }
const sent: Sent[] = []

function mockApi() {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : {},
    })
    return { ok: true, json: async () => ({ goal: {} }) }
  }) as unknown as typeof fetch
}

const goal = {
  id: 'g1',
  title: 'Read more',
  goalType: 'total',
  unit: 'pages',
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 100, progress: 10 }],
} as unknown as Goal

// Logged at 8pm on Aug 31 in a household running America/Chicago — which is
// 01:00 UTC on Sep 1. `dateKey` is the household's day; `loggedAt` is the instant.
const entry: GoalLogEntry = {
  id: 'e1',
  amount: 12,
  loggedAt: '2026-09-01T01:00:00.000Z',
  dateKey: '2026-08-31',
  note: null,
  participants: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }],
}

beforeEach(() => {
  sent.length = 0
  mockApi()
})

describe('EntryModal — a note edit stays on its own day', () => {
  it('shows the household day the entry was logged on, not the UTC one', () => {
    render(<EntryModal goal={goal} entry={entry} onClose={() => {}} onSaved={() => {}} />)
    const date = screen.getByDisplayValue('2026-08-31')
    expect(date).toBeInTheDocument()
  })

  it('keeps the entry on its day when only the note changed', async () => {
    render(<EntryModal goal={goal} entry={entry} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText(/What happened/i), { target: { value: 'finished chapter 4' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/i }))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH')!
    expect(patch.body.note).toBe('finished chapter 4')
    // The day must be untouched — not nudged forward to the UTC date.
    expect(patch.body.loggedOn).toBe('2026-08-31')
  })
})

// The date cap is the BROWSER's local today, but the field is seeded from `dateKey`
// — the HOUSEHOLD's day. A household ahead of the device (a kiosk in Chicago on a
// household set to Tokyo, or a traveller) has already turned the page, so the seeded
// day is later than the cap. The input is then :invalid, and because Save is a submit
// button inside a <form>, native validation swallows the submit: the user edits the
// note, presses Save, and nothing happens — the very "the note didn't save" symptom
// this modal was fixed to stop, coming back through a different door.
describe('EntryModal — the date cap can never block the entry it was opened on', () => {
  const dayFromToday = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  // An entry whose household day is already tomorrow as far as this browser knows.
  const aheadEntry: GoalLogEntry = { ...entry, dateKey: dayFromToday(1) }

  it('never caps below the day the entry belongs to', () => {
    render(<EntryModal goal={goal} entry={aheadEntry} onClose={() => {}} onSaved={() => {}} />)
    const date = screen.getByLabelText(/Date this happened/i) as HTMLInputElement
    expect(date.value).toBe(dayFromToday(1))
    expect(date.max >= date.value).toBe(true)
  })

  it('leaves the field valid, so Save still submits', async () => {
    render(<EntryModal goal={goal} entry={aheadEntry} onClose={() => {}} onSaved={() => {}} />)
    const date = screen.getByLabelText(/Date this happened/i) as HTMLInputElement
    expect(date.validity.rangeOverflow).toBe(false)

    fireEvent.change(screen.getByPlaceholderText(/What happened/i), { target: { value: 'late night' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/i }))
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    expect(sent.find((s) => s.method === 'PATCH')!.body.loggedOn).toBe(dayFromToday(1))
  })

  it('still caps an ordinary entry at today', () => {
    render(<EntryModal goal={goal} entry={entry} onClose={() => {}} onSaved={() => {}} />)
    const date = screen.getByLabelText(/Date this happened/i) as HTMLInputElement
    expect(date.max).toBe(dayFromToday(0))
  })
})
