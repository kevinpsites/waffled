import { parseCapture, intentSummary, type ParsedIntent } from './parse'

// Fixed "now": Thursday, June 11 2026, 9:00 AM local.
const NOW = new Date(2026, 5, 11, 9, 0, 0)
const PEOPLE = ['Wally', 'Kelly', 'Kevin', 'Lottie']
const p = (s: string): ParsedIntent | null => parseCapture(s, PEOPLE, NOW)

function asEvent(i: ParsedIntent | null) {
  if (!i || i.kind !== 'event') throw new Error(`expected event, got ${i?.kind}`)
  return i
}

describe('parseCapture — events', () => {
  it('reads the placeholder example: "Soccer Tue 4pm for Wally"', () => {
    const e = asEvent(p('Soccer Tue 4pm for Wally'))
    expect(e.title).toBe('Soccer')
    expect(e.personName).toBe('Wally')
    expect(e.allDay).toBe(false)
    const d = new Date(e.startsAt)
    expect(d.getDay()).toBe(2) // Tuesday
    expect(d.getHours()).toBe(16)
  })

  it('"tomorrow" advances one day and stays all-day without a time', () => {
    const e = asEvent(p('Dentist tomorrow'))
    expect(e.title).toBe('Dentist')
    expect(e.allDay).toBe(true)
    expect(new Date(e.startsAt).getDate()).toBe(12)
  })

  it('"tonight" implies the evening', () => {
    const e = asEvent(p('Movie night tonight'))
    expect(e.allDay).toBe(false)
    expect(new Date(e.startsAt).getHours()).toBe(18)
    expect(new Date(e.startsAt).getDate()).toBe(11)
  })

  it('parses "at 3:30pm" with minutes', () => {
    const e = asEvent(p('Call plumber today at 3:30pm'))
    const d = new Date(e.startsAt)
    expect(d.getHours()).toBe(15)
    expect(d.getMinutes()).toBe(30)
    expect(e.title).toBe('Call plumber')
  })

  it('handles a month + day in the future', () => {
    const e = asEvent(p('Trip Aug 5'))
    const d = new Date(e.startsAt)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(5)
    expect(d.getFullYear()).toBe(2026)
  })

  it('rolls a past month into next year', () => {
    const e = asEvent(p('Reunion jan 3'))
    expect(new Date(e.startsAt).getFullYear()).toBe(2027)
  })

  it('"next friday" pushes a full week out', () => {
    const e = asEvent(p('Date night next friday'))
    const d = new Date(e.startsAt)
    expect(d.getDay()).toBe(5)
    expect(d.getDate()).toBe(19) // the 12th is this Fri; next is the 19th
  })
})

describe('parseCapture — grocery', () => {
  it('routes a bare noun to grocery', () => {
    expect(p('milk')).toEqual({ kind: 'grocery', name: 'Milk', quantity: null })
  })

  it('strips a leading verb', () => {
    expect(p('buy almond milk')).toEqual({ kind: 'grocery', name: 'Almond milk', quantity: null })
  })

  it('pulls a quantity with a unit', () => {
    expect(p('2 lbs chicken thighs')).toEqual({ kind: 'grocery', name: 'Chicken thighs', quantity: '2 lbs' })
  })

  it('handles "add X to the list"', () => {
    expect(p('add paper towels to the grocery list')).toEqual({ kind: 'grocery', name: 'Paper towels', quantity: null })
  })
})

describe('parseCapture — tasks', () => {
  it('treats "remind" as a task', () => {
    const i = p('remind take out the trash for Wally')
    expect(i).toMatchObject({ kind: 'task', personName: 'Wally' })
    if (i?.kind === 'task') expect(i.title.toLowerCase()).toContain('trash')
  })

  it('detects a chore with a star reward', () => {
    const i = p('chore walk the dog for Kelly 5 stars')
    expect(i).toMatchObject({ kind: 'task', personName: 'Kelly', stars: 5 })
    if (i?.kind === 'task') expect(i.title.toLowerCase()).toContain('walk the dog')
  })

  it('an explicit "chore" beats the date heuristic and builds a weekly schedule', () => {
    const i = p('please make Wally a chore to take out the trash on Wednesday night and Sunday night.')
    expect(i?.kind).toBe('task')
    if (i?.kind !== 'task') throw new Error('expected task')
    expect(i.personName).toBe('Wally')
    expect(i.title).toBe('Take out the trash')
    expect(i.rrule).toBe('FREQ=WEEKLY;BYDAY=WE,SU')
    expect(i.scheduleLabel).toBe('Wed & Sun')
  })

  it('uses a quoted phrase as the title even when it contains the word "chore"', () => {
    const i = p('Please add "Take Out the Trash as a Chore" for Lottie on Tuesday and Thursday.')
    expect(i?.kind).toBe('task')
    if (i?.kind !== 'task') throw new Error('expected task')
    expect(i.title).toBe('Take Out the Trash')
    expect(i.personName).toBe('Lottie')
    expect(i.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH')
    expect(i.scheduleLabel).toBe('Tue & Thu')
  })

  it('handles "add X for <days> to <Person>\'s chore list" (possessive + destination)', () => {
    const i = p('Please add laundry for Monday, Wednesday, and Saturday to Kelly\'s chore list.')
    expect(i?.kind).toBe('task')
    if (i?.kind !== 'task') throw new Error('expected task')
    expect(i.title).toBe('Laundry')
    expect(i.personName).toBe('Kelly')
    expect(i.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,SA')
    expect(i.scheduleLabel).toBe('Mon & Wed & Sat')
  })

  it('"every day" becomes a daily chore', () => {
    const i = p('chore for Kevin to make the bed every day')
    expect(i?.kind).toBe('task')
    if (i?.kind !== 'task') throw new Error('expected task')
    expect(i.rrule).toBe('FREQ=DAILY')
    expect(i.title.toLowerCase()).toContain('make the bed')
  })
})

describe('parseCapture — meals', () => {
  it('routes "lets put shawarma on the meal plan" to a meal (default dinner, today)', () => {
    const i = p('lets put shawarma on the meal plan')
    expect(i?.kind).toBe('meal')
    if (i?.kind !== 'meal') throw new Error('expected meal')
    expect(i.title).toBe('Shawarma')
    expect(i.mealType).toBe('dinner')
    expect(i.date).toBeNull() // unspecified → today at commit time
  })

  it('reads the meal slot and day from "tacos for lunch on Friday"', () => {
    const i = p('tacos for lunch on Friday')
    expect(i?.kind).toBe('meal')
    if (i?.kind !== 'meal') throw new Error('expected meal')
    expect(i.title.toLowerCase()).toContain('tacos')
    expect(i.mealType).toBe('lunch')
    expect(new Date(`${i.date}T00:00:00`).getDay()).toBe(5) // Friday
  })

  it('a dinner with a clock time is an event, not a meal', () => {
    expect(p('dinner with grandma at 6pm')?.kind).toBe('event')
  })

  it('routes "we\'re eating out friday" to an Eating out meal', () => {
    const i = p("we're eating out friday")
    expect(i?.kind).toBe('meal')
    if (i?.kind !== 'meal') throw new Error('expected meal')
    expect(i.title).toBe('Eating out')
    expect(new Date(`${i.date}T00:00:00`).getDay()).toBe(5)
  })

  it('"eating out at 7pm" is a reservation (event), not a meal', () => {
    expect(p('eating out at 7pm on friday')?.kind).toBe('event')
  })
})

describe('intentSummary + edge cases', () => {
  it('returns null for empty input', () => {
    expect(p('')).toBeNull()
    expect(p('   ')).toBeNull()
  })

  it('summarizes an event for the preview chip', () => {
    const s = intentSummary(asEvent(p('Soccer Tue 4pm for Wally')))
    expect(s.icon).toBe('📅')
    expect(s.primary).toBe('Soccer')
    expect(s.detail).toContain('Wally')
  })
})
