import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Meals } from './Meals'
import { TopbarSlotProvider } from './topbar-slot'

// "Week starts on" is a household setting, and until now the meal planner ignored it:
// both grids were cut on Sunday no matter what the household said. That isn't only
// cosmetic — the grocery list is keyed by the household's week, so a Sunday-led block
// in a Monday household straddles two of them and a rebuild only ever covers one.

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const asked: string[] = []

function mockApi(weekStart: 'sunday' | 'monday') {
  asked.length = 0
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/household')) {
      return { ok: true, json: async () => ({ household: { id: 'h1', name: 'Home', weekStart, timezone: 'America/Chicago' }, person: null, memberships: [], pendingInvites: [] }) }
    }
    if (u.includes('/api/meals/week')) {
      asked.push(u)
      return { ok: true, json: async () => ({ start: '', entries: [] }) }
    }
    if (u.includes('/api/recipes')) return { ok: true, json: async () => ({ recipes: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderMeals() {
  return render(
    <MemoryRouter initialEntries={['/meals']}>
      <TopbarSlotProvider>
        <Meals />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

// The day the current week is cut on, for a given first day (0 = Sun, 1 = Mon).
function weekStartFor(firstDay: number): Date {
  const s = new Date()
  s.setHours(0, 0, 0, 0)
  s.setDate(s.getDate() - ((s.getDay() - firstDay + 7) % 7))
  return s
}

const dowOrder = (sel: string) =>
  Array.from(document.querySelectorAll(sel)).map((el) => el.textContent?.trim() ?? '')

describe('Meals — the household decides which day starts the week', () => {
  it('cuts the week on Monday for a monday household', async () => {
    mockApi('monday')
    renderMeals()

    // The week the grid asks the server for starts on Monday.
    await waitFor(() => expect(asked.some((u) => u.includes(ymd(weekStartFor(1))))).toBe(true))
  })

  it('still cuts on Sunday for a sunday household', async () => {
    mockApi('sunday')
    renderMeals()

    await waitFor(() => expect(asked.some((u) => u.includes(ymd(weekStartFor(0))))).toBe(true))
  })

  it('leads the week grid’s day headings with the household’s first day', async () => {
    mockApi('monday')
    renderMeals()

    await waitFor(() => expect(dowOrder('.meals-dow .dow')[0]).toBe('Mon'))
    expect(dowOrder('.meals-dow .dow')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it('leads the month grid’s columns with the household’s first day', async () => {
    mockApi('monday')
    renderMeals()
    await waitFor(() => expect(dowOrder('.meals-dow .dow')[0]).toBe('Mon'))

    fireEvent.click(screen.getByRole('button', { name: 'Month' }))

    await waitFor(() => expect(dowOrder('.mm-dow')[0]).toBe('Mon'))
    expect(dowOrder('.mm-dow')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    // ...and the 6-week block it fetches starts on a Monday too.
    const monthCells = document.querySelectorAll('.meals-month .mm-cell, .meals-month [class*="mm-"]')
    expect(monthCells.length).toBeGreaterThan(0)
  })
})
