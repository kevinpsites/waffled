import { peopleColumns, UNASSIGNED_COLUMN, type ColumnPerson } from './cal-people'
import type { AgendaEvent } from '../../lib/api'

// Per-person calendar columns. An event belongs in its OWNER's column
// (events.person_id — the assignee/color, not owner_person_id, which is the
// privacy flag) and additionally in the column of every participant, so a shared
// event reads from each person's lane instead of hiding under one name.
const person = (id: string, name: string): ColumnPerson => ({
  id, name, colorHex: null, avatarEmoji: null,
})

const ev = (id: string, over: Partial<AgendaEvent> = {}): AgendaEvent => ({
  id,
  title: id,
  startsAt: '2026-08-13T15:00:00.000Z',
  endsAt: null,
  allDay: false,
  location: null,
  personId: null,
  personName: null,
  personColor: null,
  personEmoji: null,
  participants: [],
  ...over,
})

const family = [person('p1', 'Jerry'), person('p2', 'Elaine'), person('p3', 'George')]

// Which column ids an event landed in, for terse assertions.
const landedIn = (cols: ReturnType<typeof peopleColumns>, eventId: string): string[] =>
  cols.filter((c) => c.events.some((e) => e.id === eventId)).map((c) => c.id)

describe('peopleColumns', () => {
  it('puts an owned event in the owner’s column', () => {
    const cols = peopleColumns([ev('e1', { personId: 'p1' })], family)
    expect(landedIn(cols, 'e1')).toEqual(['p1'])
  })

  // The point of the feature: a shared event reads from every participant's lane.
  it('repeats a shared event in every participant’s column', () => {
    const e = ev('e1', {
      personId: 'p1',
      participants: [
        { id: 'p1', name: 'Jerry', colorHex: null, avatarEmoji: null },
        { id: 'p2', name: 'Elaine', colorHex: null, avatarEmoji: null },
      ],
    })
    expect(landedIn(peopleColumns([e], family), 'e1')).toEqual(['p1', 'p2'])
  })

  // The write paths disagree about whether the owner is ALSO inserted as a
  // participant row (the iOS editor derives person_id from participants.first;
  // the meal/goal paths don't). Union both so it doesn't matter which wrote it.
  it('unions owner and participants without duplicating the owner’s column', () => {
    const e = ev('e1', {
      personId: 'p1',
      participants: [{ id: 'p2', name: 'Elaine', colorHex: null, avatarEmoji: null }],
    })
    expect(landedIn(peopleColumns([e], family), 'e1')).toEqual(['p1', 'p2'])
    const jerry = peopleColumns([e], family).find((c) => c.id === 'p1')!
    expect(jerry.events).toHaveLength(1)
  })

  // Participant rows may name someone outside the household (migration 0009
  // allows person_id NULL with an external_email). Bucketing is column-driven, so
  // an unknown id simply has no column to land in — it must not invent one.
  it('ignores participants who aren’t household people', () => {
    const e = ev('e1', {
      personId: 'p1',
      participants: [{ id: 'outside-id', name: 'Newman', colorHex: null, avatarEmoji: null }],
    })
    expect(peopleColumns([e], family).map((c) => c.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('keeps a column for every household person, even an empty one', () => {
    const cols = peopleColumns([ev('e1', { personId: 'p1' })], family)
    expect(cols.map((c) => c.id)).toEqual(['p1', 'p2', 'p3'])
    expect(cols.find((c) => c.id === 'p3')!.events).toEqual([])
  })

  // An event belonging to nobody must not vanish — it gets a leading shared
  // column rather than being dropped or smeared across everyone.
  it('collects unassigned events into a leading Everyone column', () => {
    const cols = peopleColumns([ev('e1'), ev('e2', { personId: 'p1' })], family)
    expect(cols[0].id).toBe(UNASSIGNED_COLUMN)
    expect(landedIn(cols, 'e1')).toEqual([UNASSIGNED_COLUMN])
  })

  it('omits the Everyone column when every event has someone', () => {
    const cols = peopleColumns([ev('e1', { personId: 'p1' })], family)
    expect(cols.some((c) => c.id === UNASSIGNED_COLUMN)).toBe(false)
  })

  // Each column packs its own lanes: an event shown in three columns must be
  // full-width in each, not squeezed to a third because it overlaps elsewhere.
  it('packs lanes per column, not globally', () => {
    const shared = ev('shared', {
      personId: 'p1',
      participants: [
        { id: 'p1', name: 'Jerry', colorHex: null, avatarEmoji: null },
        { id: 'p2', name: 'Elaine', colorHex: null, avatarEmoji: null },
      ],
    })
    // Overlaps `shared` but only in Jerry's column.
    const jerryOnly = ev('jerry-only', { personId: 'p1', startsAt: '2026-08-13T15:30:00.000Z' })
    const cols = peopleColumns([shared, jerryOnly], family)
    expect(cols.find((c) => c.id === 'p1')!.lanes.get('shared')!.lanes).toBe(2)
    // Elaine sees only the one event, so it spans her full column.
    expect(cols.find((c) => c.id === 'p2')!.lanes.get('shared')!.lanes).toBe(1)
  })
})
