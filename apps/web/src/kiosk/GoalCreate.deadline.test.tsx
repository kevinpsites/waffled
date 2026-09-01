import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { GoalCreate } from './GoalCreate'

// A deadline is a bare calendar day, and the edit form binds it straight into an
// <input type="date">. That input only accepts `yyyy-MM-dd` — hand it an instant and
// it renders EMPTY, so opening a goal with a deadline showed no deadline at all, and
// saving from that form would clear the one that was set. This pins the shape the
// form depends on, which is the shape the API now sends.

const lists = [
  {
    id: 'l-wally', name: 'Wally', emoji: '🐢', colorHex: '#25A368', isPrivate: false, sortOrder: 0,
    members: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }], goalCount: 0,
  },
]

const goalWith = (deadline: string | null) => ({
  id: 'g1', goalListId: 'l-wally', title: 'Read 20 books', emoji: '📚', category: 'learning',
  goalType: 'count', unit: 'books', habitPeriod: null, habitTargetPerPeriod: null,
  trackingMode: 'shared_total', autoFromCalendar: false, deadline, isFeatured: false,
  hasRewards: false, target: 20,
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 20, progress: 3 }],
  milestones: [], steps: [],
})

function mockApi(goal: unknown) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists }) }
    if (u.includes('/api/goals/g1')) return { ok: true, json: async () => ({ goal }) }
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' },
          person: { id: 'p1', name: 'Wally', memberType: 'adult', isAdmin: true, capabilities: ['goal.manage'] },
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/goals/g1/edit']}>
      <Routes>
        <Route path="/goals/:id/edit" element={<GoalCreate />} />
      </Routes>
    </MemoryRouter>
  )
}

const dateInput = () => document.querySelector('input[type="date"]') as HTMLInputElement | null

describe('GoalCreate — editing a goal shows the deadline it has', () => {
  it('fills the date field from a plain day', async () => {
    mockApi(goalWith('2026-09-30'))
    renderEdit()
    await waitFor(() => expect(dateInput()).not.toBeNull())
    expect(dateInput()!.value).toBe('2026-09-30')
  })

  it('renders empty if handed an instant instead of a day', async () => {
    // Why the server has to send a bare day: this is what the form did when the API
    // returned the `date` column as a timestamp.
    mockApi(goalWith('2026-09-30T07:00:00.000Z'))
    renderEdit()
    await waitFor(() => expect(dateInput()).not.toBeNull())
    expect(dateInput()!.value).toBe('')
  })
})
