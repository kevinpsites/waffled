import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { EntryModal } from './components/EntryModal'
import { api } from '../lib/api'

// An entry that counted itself — a checklist tick, a confirmed calendar event, an Apple
// Health sync — comes back with `editable: false`: the server keeps its amount, day and
// people in step with whatever wrote it, and refuses a delete. The sheet must therefore
// offer only the note, and send only the note, rather than fields whose save can only
// fail. (The same shape as EventDetail's read-only ICS mirror.)
const goal = {
  id: 'g1',
  goalListId: 'l1',
  title: 'Trip prep',
  emoji: '🎒',
  category: 'family',
  goalType: 'total',
  unit: 'hours',
  habitPeriod: null,
  habitTargetPerPeriod: null,
  trackingMode: 'shared_total',
  logMethod: 'quick_log',
  autoFromCalendar: false,
  deadline: null,
  isFeatured: false,
  hasRewards: false,
  target: 100,
  totalProgress: 3,
  milestoneTotal: 0,
  milestoneReached: 0,
  periodDone: 0,
  stepTotal: 0,
  stepDone: 0,
  streakDays: 0,
  createdAt: '2026-01-01T00:00:00Z',
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 100, progress: 3 }],
}

const entry = {
  id: 'log1',
  amount: 1,
  loggedAt: '2026-08-31T18:00:00Z',
  dateKey: '2026-08-31',
  note: null,
  participants: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }],
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const show = (e: any) => render(<EntryModal goal={goal as any} entry={e} onClose={() => {}} onSaved={() => {}} />)

it('a source-owned entry offers the note only — no amount, day or delete', async () => {
  const edit = vi.spyOn(api, 'editGoalLog').mockResolvedValue({} as never)
  show({ ...entry, editable: false })

  expect(screen.queryByLabelText('amount')).toBeNull()
  expect(screen.queryByLabelText('Date this happened')).toBeNull()
  expect(screen.queryByText(/Delete entry/)).toBeNull()
  expect(screen.getByText(/checklist tick, a calendar event or Apple Health/)).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText('What happened'), { target: { value: 'packed the rain gear' } })
  fireEvent.click(screen.getByText('Save changes'))
  await waitFor(() => expect(edit).toHaveBeenCalled())
  // Only the note — no amount/day/people to be refused over.
  expect(edit.mock.calls[0][2]).toEqual({ note: 'packed the rain gear' })
})

it('an ordinary entry still edits amount, day and people, and can be deleted', async () => {
  const edit = vi.spyOn(api, 'editGoalLog').mockResolvedValue({} as never)
  show({ ...entry, amount: 3, editable: true })

  expect(screen.getByLabelText('amount')).toBeTruthy()
  expect(screen.getByLabelText('Date this happened')).toBeTruthy()
  expect(screen.getByText(/Delete entry/)).toBeTruthy()

  fireEvent.click(screen.getByText('Save changes'))
  await waitFor(() => expect(edit).toHaveBeenCalled())
  expect(edit.mock.calls[0][2]).toMatchObject({ amount: 3, loggedOn: '2026-08-31' })
})
