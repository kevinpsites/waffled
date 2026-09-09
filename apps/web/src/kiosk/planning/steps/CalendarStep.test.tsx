import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import mod, { weekRangeLabel, weekSummary } from './CalendarStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 2 · Calendar. `weekStart` is pinned to a fixed Sunday rather than derived from today,
// because the whole risk in this step is date handling: `new Date('2026-09-06')` is UTC midnight
// and renders as the 5th west of Greenwich, and a test that agreed with today's date would never
// catch a row shifted by one.

const WEEK_START = '2026-09-06' // a Sunday; the week runs Sun Sep 6 -> Sat Sep 12

const Body = mod.Body

const step: PlanningStep = {
  key: 'calendar',
  number: 2,
  title: 'Calendar',
  ask: 'Here’s your week. Anything missing?',
  primary: 'Looks right',
  act: 'Frame the week',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
  parked: [],
}

const PERSONS = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED' },
  { id: 'p2', name: 'Nora', memberType: 'adult', isAdmin: false, avatarEmoji: '🦊', colorHex: '#25A368' },
]

// Built by LOCAL parse so the fixture lands on the day it says it does, whatever the zone.
const at = (day: string, time: string) => new Date(`${day}T${time}`).toISOString()

const ev = (over: Record<string, unknown>) => ({
  id: 'e0',
  title: 'Something',
  startsAt: at(WEEK_START, '09:00'),
  endsAt: null,
  allDay: false,
  location: null,
  personId: 'p1',
  personName: 'Kevin',
  personColor: '#2F7FED',
  personEmoji: '🐻',
  participants: [],
  ...over,
})

function mockApi(initial: Record<string, unknown>[]) {
  const events = [...initial]
  const reads: string[] = []
  const posts: Record<string, unknown>[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.startsWith('/api/persons')) return { ok: true, json: async () => ({ persons: PERSONS }) }
    // useEventColorSource + useHousehold both read this; no household ⇒ the device zone, which
    // is the zone the fixtures were built in.
    if (u.startsWith('/api/household')) return { ok: true, json: async () => ({ household: null, person: null }) }
    if (u.startsWith('/api/events') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      posts.push(body)
      const ids = (body.participantIds as string[] | undefined) ?? []
      const person = PERSONS.find((p) => p.id === ids[0])
      const created = ev({
        ...body,
        id: `new-${posts.length}`,
        personId: person?.id ?? null,
        personName: person?.name ?? null,
        personColor: person?.colorHex ?? null,
        personEmoji: person?.avatarEmoji ?? null,
      })
      events.push(created)
      return { ok: true, json: async () => ({ event: created }) }
    }
    if (u.startsWith('/api/events')) {
      reads.push(u)
      // A COPY per response, as a real `res.json()` gives: handing the same array back twice
      // hides the add behind React's identity check.
      return { ok: true, json: async () => ({ from: '', to: '', events: [...events] }) }
    }
    // The shared event modal also reads goals and Google calendars. Empty is the answer here —
    // but SHAPED, not `{}`: `useGoals` assigns `d.goals` straight into state, so a bare `{}`
    // crashes the modal.
    if (u.startsWith('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) }
    if (u.startsWith('/api/calendar/google/status')) return { ok: true, json: async () => ({ calendars: [] }) }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { events, reads, posts }
}

function renderStep(over: Partial<StepBodyProps> = {}) {
  const setDecisionData = vi.fn()
  const refresh = vi.fn()
  render(
    <MemoryRouter>
      <Body
        step={step}
        sessionId="s1"
        weekStart={WEEK_START}
        setDecisionData={setDecisionData}
        refresh={refresh}
        busy={false}
        {...over}
      />
    </MemoryRouter>
  )
  return { setDecisionData, refresh }
}

const day = (key: string) => screen.getByTestId(`wpc-day-${key}`)

async function eventModal(): Promise<HTMLElement> {
  const heading = await screen.findByText('New event')
  return heading.closest('.modal-card') as HTMLElement
}
const modalIsOpen = () => !!screen.queryByText('New event')

async function compose(dayName: string, text: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`add an event on ${dayName}`, 'i') }))
  const modal = await eventModal()
  fireEvent.change(within(modal).getByLabelText('Title'), { target: { value: text } })
  return modal
}

describe('Weekly planning · step 2 · Calendar', () => {
  it('shows the planned week as seven day rows of the real calendar', async () => {
    const { reads } = mockApi([
      ev({ id: 'dentist', title: 'Dentist', startsAt: at('2026-09-08', '15:00') }),
      ev({ id: 'swim', title: 'Swim meet', startsAt: at('2026-09-12', '09:00'), personId: 'p2', personName: 'Nora', personColor: '#25A368', personEmoji: '🦊' }),
    ])
    renderStep()

    await waitFor(() => expect(day('2026-09-06')).toBeInTheDocument())
    for (const k of ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
      expect(day(k)).toBeInTheDocument()
    }
    expect(within(day('2026-09-06')).getByText('SUN')).toBeInTheDocument()
    expect(within(day('2026-09-06')).getByText('Sep 6')).toBeInTheDocument()
    expect(within(day('2026-09-12')).getByText('SAT')).toBeInTheDocument()
    expect(within(day('2026-09-12')).getByText('Sep 12')).toBeInTheDocument()

    expect(await within(day('2026-09-08')).findByText('Dentist')).toBeInTheDocument()
    expect(within(day('2026-09-12')).getByText('Swim meet')).toBeInTheDocument()
    expect(within(day('2026-09-07')).getByText('Nothing on the calendar')).toBeInTheDocument()

    // The window is exactly the planned week — an off-by-one here silently empties a row.
    expect(reads.some((u) => u.includes('from=2026-09-06') && u.includes('to=2026-09-12'))).toBe(true)
  })

  it('heads the week with its range, a plain-language summary and the one way in', async () => {
    mockApi([
      ev({ id: 'a', title: 'Dentist', startsAt: at('2026-09-08', '15:00') }),
      ev({ id: 'b', title: 'Swim meet', startsAt: at('2026-09-12', '09:00') }),
    ])
    renderStep()

    expect(await screen.findByText('Sep 6 – 12')).toBeInTheDocument()
    expect(
      await screen.findByText('2 events · Sunday, Monday, Wednesday, Thursday and Friday are still open')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add an event$/i })).toBeInTheDocument()

    expect(screen.getByText('This is everything your calendars already have. Add what isn’t here yet.')).toBeInTheDocument()
  })

  it('says every day has something when nothing is open', async () => {
    mockApi(
      ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'].map((d, i) =>
        ev({ id: `d${i}`, title: `Thing ${i}`, startsAt: at(d, '09:00') })
      )
    )
    renderStep()
    expect(await screen.findByText('7 events · every day has something')).toBeInTheDocument()
  })

  it('draws each event as a chip: its time, its title in the owner’s colour, their avatar', async () => {
    mockApi([
      ev({ id: 'dentist', title: 'Dentist', startsAt: at('2026-09-08', '13:00'), personColor: '#2F7FED', personEmoji: '🐻' }),
      ev({ id: 'bins', title: 'Bins out', startsAt: at('2026-09-09', '12:00'), allDay: true, personId: null, personName: null, personColor: null, personEmoji: null }),
    ])
    renderStep()

    const chip = (await within(day('2026-09-08')).findByText('Dentist')).closest('.wpc-chip') as HTMLElement
    expect(chip).toBeTruthy()
    expect(within(chip).getByText('1:00 PM')).toBeInTheDocument()
    expect(chip.style.getPropertyValue('--ev')).toBe('#2F7FED')
    expect(within(chip).getByText('🐻')).toBeInTheDocument()

    const bins = (within(day('2026-09-09')).getByText('Bins out')).closest('.wpc-chip') as HTMLElement
    expect(within(bins).getByText('All day')).toBeInTheDocument()
    expect(bins.style.getPropertyValue('--ev')).toBe('#6B6B70')
  })

  it('opens the app’s own event modal on the day whose + was tapped', async () => {
    mockApi([])
    renderStep()

    fireEvent.click(await screen.findByRole('button', { name: /add an event on wednesday, sep 9/i }))
    const modal = await eventModal()
    expect(within(modal).getByLabelText('Date')).toHaveValue('2026-09-09')
    expect(within(modal).getByLabelText('Duration')).toBeInTheDocument()
    expect(within(modal).getByText('Repeats')).toBeInTheDocument()
    expect(within(modal).getByLabelText('Location (optional)')).toBeInTheDocument()
  })

  it('adds the event AT THE TIME THAT WAS PICKED, for as long as was picked', async () => {
    // The old inline composer's time control was an invisible chip-sized `input[type=time]` and
    // every event landed at the 5pm default. A real time and duration have to reach the calendar.
    const { posts } = mockApi([])
    const { setDecisionData, refresh } = renderStep()

    const modal = await compose('wednesday, sep 9', 'Soccer practice')
    fireEvent.change(within(modal).getByLabelText('Time'), { target: { value: '08:30' } })
    fireEvent.change(within(modal).getByLabelText('Duration'), { target: { value: '120' } })
    fireEvent.click(await within(modal).findByRole('button', { name: /Nora/ }))
    fireEvent.click(within(modal).getByRole('button', { name: /add event/i }))

    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]).toMatchObject({ title: 'Soccer practice', allDay: false, participantIds: ['p2'] })
    expect(posts[0].startsAt).toBe(at('2026-09-09', '08:30'))
    expect(posts[0].endsAt).toBe(at('2026-09-09', '10:30'))

    expect(await within(day('2026-09-09')).findByText('Soccer practice')).toBeInTheDocument()
    await waitFor(() => expect(modalIsOpen()).toBe(false))

    expect(setDecisionData).toHaveBeenCalledWith({ added: 1 })
    expect(refresh).toHaveBeenCalled()
  })

  it('puts one event on more than one person — both parents is the ordinary case', async () => {
    const { posts } = mockApi([])
    renderStep()

    const modal = await compose('thursday, sep 10', 'Parent-teacher night')
    fireEvent.click(within(modal).getByRole('button', { name: /Kevin/ }))
    fireEvent.click(await within(modal).findByRole('button', { name: /Nora/ }))
    fireEvent.click(within(modal).getByRole('button', { name: /add event/i }))

    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0].participantIds).toEqual(['p1', 'p2'])
  })

  it('keeps all-day expressible, filed at midday so it cannot slide into the day next door', async () => {
    const { posts } = mockApi([])
    renderStep()

    const modal = await compose('friday, sep 11', 'Grandma visits')
    fireEvent.click(within(modal).getByLabelText('All day'))
    fireEvent.click(within(modal).getByRole('button', { name: /add event/i }))

    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]).toMatchObject({ title: 'Grandma visits', allDay: true, endsAt: null })
    expect(posts[0].startsAt).toBe(at('2026-09-11', '12:00'))
  })

  it('opens the modal from the header too, on a day inside the week being planned', async () => {
    mockApi([])
    renderStep()

    fireEvent.click(await screen.findByRole('button', { name: /add an event$/i }))
    const modal = await eventModal()
    const chosen = (within(modal).getByLabelText('Date') as HTMLInputElement).value
    expect(chosen >= '2026-09-06' && chosen <= '2026-09-12').toBe(true)
  })

  it('keeps a busy day to one screen: four events, then “+N more”, which opens that day', async () => {
    mockApi([
      ev({ id: 'a', title: 'Breakfast club', startsAt: at('2026-09-08', '07:00') }),
      ev({ id: 'b', title: 'Standup', startsAt: at('2026-09-08', '09:00') }),
      ev({ id: 'c', title: 'Dentist', startsAt: at('2026-09-08', '11:00') }),
      ev({ id: 'd', title: 'Lunch', startsAt: at('2026-09-08', '12:00') }),
      ev({ id: 'e', title: 'Piano', startsAt: at('2026-09-08', '16:00') }),
      ev({ id: 'f', title: 'Book club', startsAt: at('2026-09-08', '19:00') }),
    ])
    renderStep()

    const row = day('2026-09-08')
    expect(await within(row).findByText('Breakfast club')).toBeInTheDocument()
    expect(within(row).getByText('Lunch')).toBeInTheDocument()
    expect(within(row).queryByText('Piano')).not.toBeInTheDocument()

    fireEvent.click(within(row).getByRole('button', { name: '+2 more' }))
    expect(within(row).getByText('Piano')).toBeInTheDocument()
    expect(within(row).getByText('Book club')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /more/ })).not.toBeInTheDocument()

    expect(
      screen.getByText('Busy weeks stay one screen — a day over four events shows “+N more”, which opens that day.')
    ).toBeInTheDocument()
  })

  it('shows all four of a four-event day, with no pill', async () => {
    mockApi([
      ev({ id: 'a', title: 'One', startsAt: at('2026-09-08', '07:00') }),
      ev({ id: 'b', title: 'Two', startsAt: at('2026-09-08', '09:00') }),
      ev({ id: 'c', title: 'Three', startsAt: at('2026-09-08', '11:00') }),
      ev({ id: 'd', title: 'Four', startsAt: at('2026-09-08', '12:00') }),
    ])
    renderStep()

    const row = day('2026-09-08')
    expect(await within(row).findByText('Four')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /more/ })).not.toBeInTheDocument()
  })

  it('backs out of the modal without adding anything, and leaves no crumb', async () => {
    const { posts } = mockApi([])
    const { setDecisionData } = renderStep()

    const modal = await compose('tuesday, sep 8', 'Never mind')
    fireEvent.click(within(modal).getByRole('button', { name: /close/i }))

    await waitFor(() => expect(modalIsOpen()).toBe(false))
    expect(posts.length).toBe(0)
    expect(setDecisionData).not.toHaveBeenCalled()
  })

  it('stops offering the add while the session is writing', async () => {
    mockApi([])
    renderStep({ busy: true })
    expect(await screen.findByRole('button', { name: /add an event$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add an event on sunday, sep 6/i })).toBeDisabled()
  })
})

describe('the week’s own summary', () => {
  it('names the range, across a month boundary too', () => {
    expect(weekRangeLabel('2026-09-06')).toBe('Sep 6 – 12')
    expect(weekRangeLabel('2026-09-27')).toBe('Sep 27 – Oct 3')
  })

  it('counts what is on the week and names what is still open', () => {
    expect(weekSummary(0, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])).toBe(
      'Nothing on the week yet · every day is still open'
    )
    expect(weekSummary(1, ['Sunday'])).toBe('1 event · Sunday is still open')
    expect(weekSummary(7, ['Sunday', 'Thursday'])).toBe('7 events · Sunday and Thursday are still open')
    expect(weekSummary(9, ['Sunday', 'Thursday', 'Friday'])).toBe('9 events · Sunday, Thursday and Friday are still open')
    expect(weekSummary(28, [])).toBe('28 events · every day has something')
  })
})
