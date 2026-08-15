import { render, screen } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import type { AgendaEvent } from '../../lib/api'
import type { ColumnPerson } from './cal-people'

// Renders one day as a column per person. The helper's bucketing is covered in
// cal-people.test.ts; this locks the RENDERING of a shared event — it must appear
// once per column rather than being deduped away by a colliding React key.
const person = (id: string, name: string): ColumnPerson => ({
  id, name, colorHex: '#4477EE', avatarEmoji: null,
})

const ev = (id: string, over: Partial<AgendaEvent> = {}): AgendaEvent => ({
  id,
  title: id,
  startsAt: '2026-08-28T19:30:00',
  endsAt: '2026-08-28T21:00:00',
  allDay: false,
  location: null,
  personId: null,
  personName: null,
  personColor: null,
  personEmoji: null,
  participants: [],
  ...over,
})

const family = [person('p1', 'Jerry'), person('p2', 'Elaine')]
const day = new Date('2026-08-28T12:00:00')
const noop = () => {}

describe('PeopleView', () => {
  it('draws a column per household person', () => {
    render(<PeopleView day={day} events={[]} people={family} tz="America/Los_Angeles" onOpenEvent={noop} onCreate={noop} />)
    expect(document.querySelectorAll('.pv-day-h')).toHaveLength(2)
    expect(screen.getByText('Jerry')).toBeInTheDocument()
    expect(screen.getByText('Elaine')).toBeInTheDocument()
  })

  // A person's column is meant to BE a week column, not a lookalike: the header,
  // all-day row and body must share the week grid's one `--wk-cols` template, or
  // they drift out of alignment the moment a name is long.
  it('is built on the week grid, with a track per person', () => {
    render(<PeopleView day={day} events={[]} people={family} tz="America/Los_Angeles" onOpenEvent={noop} onCreate={noop} />)
    const wk = document.querySelector('.wk') as HTMLElement
    expect(wk).toBeTruthy()
    expect(wk.style.getPropertyValue('--wk-cols')).toContain('repeat(2,')
    expect(document.querySelector('.wk-head')).toBeTruthy()
    expect(document.querySelectorAll('.wk-col')).toHaveLength(2)
  })

  it('shows a shared event in each participant’s column', () => {
    const shared = ev('movie', {
      title: 'Family movie night',
      personId: 'p1',
      participants: [
        { id: 'p1', name: 'Jerry', colorHex: null, avatarEmoji: null },
        { id: 'p2', name: 'Elaine', colorHex: null, avatarEmoji: null },
      ],
    })
    render(<PeopleView day={day} events={[shared]} people={family} tz="America/Los_Angeles" onOpenEvent={noop} onCreate={noop} />)
    expect(screen.getAllByText('Family movie night')).toHaveLength(2)
  })

  it('leaves a person’s column empty when nothing is theirs', () => {
    const mine = ev('solo', { title: 'Poker night', personId: 'p1' })
    render(<PeopleView day={day} events={[mine]} people={family} tz="America/Los_Angeles" onOpenEvent={noop} onCreate={noop} />)
    const cols = document.querySelectorAll('.wk-col')
    expect(cols[0].querySelectorAll('.wk-ev')).toHaveLength(1)
    expect(cols[1].querySelectorAll('.wk-ev')).toHaveLength(0)
  })

  it('asks for family members when the household has none', () => {
    render(<PeopleView day={day} events={[]} people={[]} tz="America/Los_Angeles" onOpenEvent={noop} onCreate={noop} />)
    expect(screen.getByText(/add family members/i)).toBeInTheDocument()
  })

  // The roster arrives async, so an empty `people` means "not here yet" as often as
  // it means "nobody" — and telling a four-person household to add family members
  // while its own roster is in flight is a false claim, not just a flicker.
  it('does not ask for family members while the roster is still loading', () => {
    render(<PeopleView day={day} events={[]} people={[]} loading tz="America/Los_Angeles" onOpenEvent={noop} onCreate={noop} />)
    expect(screen.queryByText(/add family members/i)).not.toBeInTheDocument()
  })
})
