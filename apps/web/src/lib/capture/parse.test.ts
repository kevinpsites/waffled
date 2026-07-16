import { parseCapture, intentSummary, looksConfident, type ParsedIntent } from './parse'

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

  // Finding #3: a soft "I want to …" trigger must not steal a meal phrase for a goal.
  it('"I want to have tacos for dinner tomorrow" is a meal, not a goal', () => {
    const i = p('I want to have tacos for dinner tomorrow')
    expect(i?.kind).toBe('meal')
    if (i?.kind !== 'meal') throw new Error('expected meal')
    expect(i.title).toBe('Tacos')
    expect(i.mealType).toBe('dinner')
    expect(new Date(`${i.date}T00:00:00`).getDate()).toBe(12) // tomorrow (Jun 12)
  })

  // Regression guard for Finding #3: a soft trigger with NO meal signal is still a goal.
  it('"I want to get in shape" stays a habit goal (soft-trigger regression)', () => {
    expect(p('I want to get in shape')?.kind).toBe('goal')
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

describe('parseCapture — person', () => {
  it('"add my son Max" → a kid family member', () => {
    const i = p('add my son Max')
    expect(i?.kind).toBe('person')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Max')
    expect(i.memberType).toBe('kid')
    expect(i.isAdmin).toBe(false)
  })

  it('"add my daughter Jane" → a kid', () => {
    const i = p('add my daughter Jane')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Jane')
    expect(i.memberType).toBe('kid')
  })

  it('"add my wife Sara" → an adult', () => {
    const i = p('add my wife Sara')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Sara')
    expect(i.memberType).toBe('adult')
  })

  it('"add a family member named Robin" → an adult by default', () => {
    const i = p('add a family member named Robin')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Robin')
    expect(i.memberType).toBe('adult')
  })

  it('"create a profile for Max" → a person', () => {
    const i = p('create a profile for Max')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Max')
  })

  it('drops a trailing age (no birthday is invented)', () => {
    const i = p('add my son Max, age 8')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Max')
    expect(i.birthday).toBeNull()
  })

  it('summarizes a person for the preview chip', () => {
    const i = p('add my son Max')
    if (i?.kind !== 'person') throw new Error('expected person')
    const s = intentSummary(i)
    expect(s.kind).toBe('Family member')
    expect(s.primary).toBe('Max')
    expect(s.detail).toBe('Kid')
  })

  // Finding #4: a possessive + a date is a calendar/countdown item, NOT a new member
  // named "'s birthday on June 5".
  it('"add my mom\'s birthday on June 5" is not a person (possessive + date)', () => {
    expect(p("add my mom's birthday on June 5")?.kind).not.toBe('person')
  })

  // Finding #4: "boy scouts" (an ordinary noun containing "boy") + a weekday is not a kid.
  it('"add boy scouts meeting Tuesday" is not a person', () => {
    expect(p('add boy scouts meeting Tuesday')?.kind).not.toBe('person')
  })

  // Regression guards for Finding #4: real profile-add phrases still route to person.
  it('"add a family member Jane" is still a person', () => {
    const i = p('add a family member Jane')
    if (i?.kind !== 'person') throw new Error('expected person')
    expect(i.name).toBe('Jane')
  })
})

describe('parseCapture — goal', () => {
  // Last day of the next occurrence of a given month (0-based), computed from NOW so
  // the assertion tracks the clock instead of a hardcoded year.
  const endOfNextMonth = (mo0: number): string => {
    let year = NOW.getFullYear()
    if (mo0 < NOW.getMonth()) year += 1
    const d = new Date(year, mo0 + 1, 0) // day 0 of the next month = the last day of this one
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('loosened trigger: "set a personal goal to run 10 miles by september" is a goal (not grocery)', () => {
    const i = p('set a personal goal to run 10 miles by september')
    expect(i?.kind).toBe('goal')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    // The offline heuristic now infers the total, the unit, and the deadline, and strips
    // them out of the title.
    expect(i.title).toBe('Run')
    expect(i.goalType).toBe('total')
    expect(i.targetValue).toBe(10)
    expect(i.unit).toBe('miles')
    expect(i.deadline).toBe(endOfNextMonth(8)) // end of the next September
  })

  it('"set a personal goal to run 10 miles" (no deadline) still routes to goal, not grocery', () => {
    const i = p('set a personal goal to run 10 miles')
    expect(i?.kind).toBe('goal')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.title).toBe('Run')
    expect(i.goalType).toBe('total')
    expect(i.targetValue).toBe(10)
    expect(i.unit).toBe('miles')
    expect(i.deadline).toBeNull()
  })

  it('"set a new goal to read 20 books" → a count goal with a whole-number target', () => {
    const i = p('set a new goal to read 20 books')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.title).toBe('Read')
    expect(i.goalType).toBe('count')
    expect(i.targetValue).toBe(20)
    expect(i.unit).toBe('books')
    expect(i.deadline).toBeNull()
  })

  it('"this year" resolves to a Dec 31 deadline', () => {
    const i = p('set a goal to read 20 books this year')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.goalType).toBe('count')
    expect(i.targetValue).toBe(20)
    expect(i.unit).toBe('books')
    expect(i.deadline).toBe(`${NOW.getFullYear()}-12-31`)
  })

  it('infers a money total from "$": "my goal is to save $500" → total/500/dollars', () => {
    const i = p('my goal is to save $500')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.title).toBe('Save')
    expect(i.goalType).toBe('total')
    expect(i.targetValue).toBe(500)
    expect(i.unit).toBe('dollars')
  })

  it('"I want to get in shape" → a habit with no target', () => {
    const i = p('I want to get in shape')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.title).toBe('Get in shape')
    expect(i.goalType).toBe('habit')
    expect(i.targetValue).toBeNull()
    expect(i.unit).toBeNull()
  })

  it('"new goal: meditate every day" → a habit', () => {
    const i = p('new goal: meditate every day')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.title).toBe('Meditate every day')
    expect(i.goalType).toBe('habit')
  })

  it('does not mistake "I want fish for dinner" for a goal', () => {
    // "I want to…" is the trigger, not "I want <noun>" — this is a meal.
    expect(p('I want fish for dinner')?.kind).toBe('meal')
  })

  it('defaults the assignment to a just-me shared total (empty participant list)', () => {
    const i = p('set a goal to run 10 miles')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.trackingMode).toBe('shared_total')
    expect(i.participantMode).toBe('count_once')
    expect(i.targetBasis).toBe('family')
    expect(i.participantIds).toEqual([])
  })

  it('infers an "everyone" audience from a family phrase', () => {
    const i = p('set a family goal to walk 30 min per day')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.audience).toBe('everyone')
  })

  it('infers a "me" audience from a personal phrase', () => {
    const i = p('set a personal goal to run 10 miles')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.audience).toBe('me')
  })

  it('leaves audience null when the phrase gives no who-hint (defaults to Just me)', () => {
    const i = p('set a goal to read 20 books')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    expect(i.audience).toBeNull()
  })

  it('summarizes a goal for the preview chip', () => {
    const i = p('set a goal to read 20 books')
    if (i?.kind !== 'goal') throw new Error('expected goal')
    const s = intentSummary(i)
    expect(s.icon).toBe('🎯')
    expect(s.kind).toBe('Goal')
    expect(s.primary).toBe('Read')
    expect(s.detail).toContain('20 books')
  })
})

describe('parseCapture — pantry (and grocery vs pantry)', () => {
  it('"add milk to the pantry" → a pantry item on hand', () => {
    const i = p('add milk to the pantry')
    expect(i?.kind).toBe('pantry')
    if (i?.kind !== 'pantry') throw new Error('expected pantry')
    expect(i.name).toBe('Milk')
    expect(i.location).toBe('Pantry')
    expect(i.amount).toBeNull()
    expect(i.unit).toBeNull()
  })

  it('"put 2 cans of beans in the pantry" → pantry with amount + unit', () => {
    const i = p('put 2 cans of beans in the pantry')
    if (i?.kind !== 'pantry') throw new Error('expected pantry')
    expect(i.name).toBe('Beans')
    expect(i.amount).toBe('2')
    expect(i.unit).toBe('cans')
    expect(i.location).toBe('Pantry')
  })

  it('"we have milk in the fridge" → pantry stored in the Fridge', () => {
    const i = p('we have milk in the fridge')
    if (i?.kind !== 'pantry') throw new Error('expected pantry')
    expect(i.name).toBe('Milk')
    expect(i.location).toBe('Fridge')
  })

  // Regression: pantry must NOT steal groceries. A bare "add milk" and an explicit
  // shopping-list target both stay grocery — only an explicit pantry/fridge/freezer
  // destination routes to pantry.
  it('"add milk" (no destination) stays grocery', () => {
    expect(p('add milk')?.kind).toBe('grocery')
  })

  it('"add milk to the shopping list" stays grocery', () => {
    expect(p('add milk to the shopping list')?.kind).toBe('grocery')
  })

  it('summarizes a pantry item for the preview chip', () => {
    const i = p('put 2 cans of beans in the pantry')
    if (i?.kind !== 'pantry') throw new Error('expected pantry')
    const s = intentSummary(i)
    expect(s.icon).toBe('🥫')
    expect(s.kind).toBe('Pantry')
    expect(s.primary).toBe('2 cans Beans')
    expect(s.detail).toContain('Pantry')
  })
})

describe('parseCapture — reward', () => {
  it('"add a reward: ice cream night for 50 stars" → a reward with cost', () => {
    const i = p('add a reward: ice cream night for 50 stars')
    expect(i?.kind).toBe('reward')
    if (i?.kind !== 'reward') throw new Error('expected reward')
    expect(i.title).toBe('Ice cream night')
    expect(i.cost).toBe(50)
    expect(i.requiresApproval).toBeNull()
  })

  it('"new reward extra screen time costs 100 points" → cost 100', () => {
    const i = p('new reward extra screen time costs 100 points')
    if (i?.kind !== 'reward') throw new Error('expected reward')
    expect(i.title).toBe('Extra screen time')
    expect(i.cost).toBe(100)
  })

  it('"reward: movie night" → a reward with no cost', () => {
    const i = p('reward: movie night')
    if (i?.kind !== 'reward') throw new Error('expected reward')
    expect(i.title).toBe('Movie night')
    expect(i.cost).toBeNull()
  })

  // Regression: the explicit word "reward" triggers this — a bare grocery/chore doesn't.
  it('"add ice cream" (no "reward") stays grocery', () => {
    expect(p('add ice cream')?.kind).toBe('grocery')
  })

  it('summarizes a reward for the preview chip', () => {
    const i = p('add a reward: ice cream night for 50 stars')
    if (i?.kind !== 'reward') throw new Error('expected reward')
    const s = intentSummary(i)
    expect(s.icon).toBe('🎁')
    expect(s.kind).toBe('Reward')
    expect(s.primary).toBe('Ice cream night')
    expect(s.detail).toContain('50★')
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

// ── Tier 2: mutate verbs ────────────────────────────────────────────────────────
// The offline heuristic detects a mutation verb and returns a NON-committable
// `mutate` marker (best-effort verb + rough targetKind); the real verb/targetKind/id
// come from the SERVER intent + /api/capture/resolve. `looksConfident` is false for
// mutate so the bar shows "thinking" and never auto-commits offline.
describe('parseCapture — mutate verbs (Tier 2)', () => {
  const asMutate = (i: ParsedIntent | null) => {
    if (!i || i.kind !== 'mutate') throw new Error(`expected mutate, got ${i?.kind}`)
    return i
  }

  it('"mark the trash chore done" → complete a chore', () => {
    const m = asMutate(p('mark the trash chore done'))
    expect(m.verb).toBe('complete')
    expect(m.targetKind).toBe('chore')
    expect(m.target.description.toLowerCase()).toContain('trash')
  })

  it('"log 20 min on my reading goal" → log a goal', () => {
    const m = asMutate(p('log 20 min on my reading goal'))
    expect(m.verb).toBe('log')
    expect(m.targetKind).toBe('goal')
  })

  it('"delete the dentist appointment" → delete an event', () => {
    const m = asMutate(p('delete the dentist appointment'))
    expect(m.verb).toBe('delete')
    expect(m.targetKind).toBe('event')
  })

  it('"cross milk off the list" → complete a list item', () => {
    const m = asMutate(p('cross milk off the list'))
    expect(m.verb).toBe('complete')
    expect(m.targetKind).toBe('listItem')
  })

  it('"give the dishes to Wally" → reassign', () => {
    const m = asMutate(p('give the dishes to Wally'))
    expect(m.verb).toBe('reassign')
  })

  it('a mutate marker is NEVER confident (forces the server path, no offline auto-commit)', () => {
    expect(looksConfident(p('mark the trash chore done'), 'mark the trash chore done')).toBe(false)
    expect(looksConfident(p('delete the dentist appointment'), 'delete the dentist appointment')).toBe(false)
  })

  it('regression: create phrases still parse as their create kind', () => {
    expect(p('Soccer Tue 4pm for Wally')?.kind).toBe('event')
    expect(p('add milk to the grocery list')?.kind).toBe('grocery')
    expect(p('set a goal to read 20 books')?.kind).toBe('goal')
    expect(p('add a reward: ice cream night for 50 stars')?.kind).toBe('reward')
  })

  it('summarizes a mutate for the preview chip (primary = the description)', () => {
    const s = intentSummary(asMutate(p('delete the dentist appointment')))
    expect(s.primary.toLowerCase()).toContain('dentist')
    expect(s.kind).toBeTruthy()
  })
})
