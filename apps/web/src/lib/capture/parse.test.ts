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

describe('parseCapture — recurring events', () => {
  it('"every Tuesday at 4pm" → weekly on Tue, anchored at the next Tuesday', () => {
    const e = asEvent(p('soccer every Tuesday at 4pm for Wally'))
    expect(e.title).toBe('Soccer')
    expect(e.personName).toBe('Wally')
    expect(e.rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
    const d = new Date(e.startsAt)
    expect(d.getDay()).toBe(2)
    expect(d.getHours()).toBe(16)
  })

  it('"every weekday" → Mon–Fri', () => {
    const e = asEvent(p('standup every weekday at 9am'))
    expect(e.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    expect(new Date(e.startsAt).getHours()).toBe(9)
  })

  it('"every day" → daily', () => {
    const e = asEvent(p('team huddle every day at 9am'))
    expect(e.rrule).toBe('FREQ=DAILY')
  })

  it('"monthly" with no concrete day still becomes a (monthly) event', () => {
    const e = asEvent(p('book club monthly'))
    expect(e.title).toBe('Book club')
    expect(e.rrule).toBe('FREQ=MONTHLY')
  })

  it('"every other Tuesday" → biweekly', () => {
    const e = asEvent(p('yoga every other tuesday at 6pm'))
    expect(e.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')
  })

  it('a plural weekday ("Tuesdays") implies weekly', () => {
    expect(asEvent(p('trash pickup tuesdays')).rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
  })

  it('a bare single weekday is a one-off, not recurring', () => {
    expect(asEvent(p('Soccer Tue 4pm for Wally')).rrule).toBeNull()
  })

  it('strips a leading command + "to X’s calendar" from the title', () => {
    const e = asEvent(p("Add gymnastics to Lottie's calendar every Tuesday at noon"))
    expect(e.title).toBe('Gymnastics')
    expect(e.personName).toBe('Lottie')
    expect(e.rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(new Date(e.startsAt).getHours()).toBe(12)
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

describe('parseCapture — countdown', () => {
  it('"12 days until Disney" → a countdown 12 days out', () => {
    const i = p('12 days until Disney')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Disney')
    expect(i.date).toBe('2026-06-23') // June 11 + 12 days
  })

  it('"Disney in 12 days" → the same countdown', () => {
    const i = p('Disney in 12 days')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Disney')
    expect(i.date).toBe('2026-06-23')
  })

  it('"10 sleeps until Christmas" → a countdown', () => {
    const i = p('10 sleeps until Christmas')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Christmas')
    expect(i.date).toBe('2026-06-21') // June 11 + 10 days
  })

  it('"countdown to the beach party on August 25" reads the explicit date', () => {
    const i = p('countdown to the beach party on August 25')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Beach party')
    expect(new Date(`${i.date}T00:00:00`).getMonth()).toBe(7) // August
    expect(new Date(`${i.date}T00:00:00`).getDate()).toBe(25)
  })

  it('a countdown with a clock time is an event, not a countdown', () => {
    // "New Year at midnight" carries a time → schedule it as an event.
    expect(p('countdown to New Year at 6pm')?.kind).toBe('event')
  })

  // Compute the nth <weekday> of a month from `now` so assertions stay correct
  // as the clock moves (0=Sun … 6=Sat).
  function nthWeekday(year: number, month0: number, weekday: number, n: number): Date {
    const first = new Date(year, month0, 1)
    const offset = (weekday - first.getDay() + 7) % 7
    return new Date(year, month0, 1 + offset + (n - 1) * 7)
  }
  function easter(year: number): Date {
    const a = year % 19
    const b = Math.floor(year / 100)
    const c = year % 100
    const d = Math.floor(b / 4)
    const e = b % 4
    const f = Math.floor((b + 8) / 25)
    const g = Math.floor((b - f + 1) / 3)
    const h = (19 * a + b - d - g + 15) % 30
    const i = Math.floor(c / 4)
    const k = c % 4
    const l = (32 + 2 * e + 2 * i - h - k) % 7
    const mm = Math.floor((a + 11 * h + 22 * l) / 451)
    const month = Math.floor((h + l - 7 * mm + 114) / 31)
    const day = ((h + l - 7 * mm + 114) % 31) + 1
    return new Date(year, month - 1, day)
  }
  const ymd = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`

  it('"add a countdown for thanksgiving" resolves the holiday to its next date', () => {
    const i = p('add a countdown for thanksgiving')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Thanksgiving')
    // 4th Thursday of November 2026 (in the future relative to NOW = Jun 11 2026).
    expect(i.date).toBe(ymd(nthWeekday(2026, 10, 4, 4)))
  })

  it('"add a countdown for november 20th" accepts the "for" connector + explicit date', () => {
    const i = p('add a countdown for november 20th')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Countdown')
    expect(i.date).toBe('2026-11-20')
  })

  it('"countdown to Christmas" resolves to the next Dec 25', () => {
    const i = p('countdown to Christmas')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Christmas')
    expect(i.date).toBe('2026-12-25')
  })

  it('"countdown to Easter" resolves via Computus (rolls past Easter to next year)', () => {
    const i = p('countdown to Easter')
    expect(i?.kind).toBe('countdown')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    expect(i.title).toBe('Easter')
    // Easter 2026 (Apr 5) is already past NOW (Jun 11) → next is Easter 2027.
    expect(i.date).toBe(ymd(easter(2027)))
  })

  it('"dentist Tuesday 3pm" is an event, not a countdown (clock time bails)', () => {
    expect(p('dentist Tuesday 3pm')?.kind).toBe('event')
  })

  it('summarizes a countdown for the preview chip', () => {
    const i = p('12 days until Disney')
    if (i?.kind !== 'countdown') throw new Error('expected countdown')
    const s = intentSummary(i)
    expect(s.kind).toBe('Countdown')
    expect(s.primary).toBe('Disney')
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
