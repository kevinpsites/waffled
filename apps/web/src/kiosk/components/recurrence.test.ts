import { buildRrule, parseRepeat, describeRrule, NO_REPEAT, weekdayCode, nthWeekdayOfMonth, type RepeatState } from './recurrence'

const st = (over: Partial<RepeatState>): RepeatState => ({ ...NO_REPEAT, ...over })

// Reference dates: a Monday, a Wednesday, and the 2nd Tuesday of June 2026.
const MON = new Date('2026-06-22T12:00:00')
const WED = new Date('2026-06-10T12:00:00')
const TUE_2ND = new Date('2026-06-09T12:00:00')

describe('buildRrule — presets', () => {
  it('returns null for none', () => {
    expect(buildRrule(st({ freq: 'none' }), MON)).toBeNull()
  })
  it('builds daily', () => {
    expect(buildRrule(st({ freq: 'daily' }), MON)).toBe('FREQ=DAILY')
  })
  it('builds weekdays', () => {
    expect(buildRrule(st({ freq: 'weekdays' }), MON)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  })
  it('builds weekly with the start weekday when none selected', () => {
    expect(buildRrule(st({ freq: 'weekly', byday: [] }), WED)).toBe('FREQ=WEEKLY;BYDAY=WE')
  })
  it('builds weekly with selected days', () => {
    expect(buildRrule(st({ freq: 'weekly', byday: ['MO', 'TH'] }), WED)).toBe('FREQ=WEEKLY;BYDAY=MO,TH')
  })
  it('builds monthly', () => {
    expect(buildRrule(st({ freq: 'monthly' }), MON)).toBe('FREQ=MONTHLY')
  })
})

describe('buildRrule — custom builder', () => {
  it('every N days', () => {
    expect(buildRrule(st({ freq: 'custom', unit: 'day', interval: 3 }), MON)).toBe('FREQ=DAILY;INTERVAL=3')
  })
  it('every N weeks on chosen days (defaults to start weekday)', () => {
    expect(buildRrule(st({ freq: 'custom', unit: 'week', interval: 2, byday: ['TU', 'TH'] }), MON)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')
    expect(buildRrule(st({ freq: 'custom', unit: 'week', interval: 2, byday: [] }), MON)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')
  })
  it('every N months by day-of-month vs nth weekday vs last weekday', () => {
    expect(buildRrule(st({ freq: 'custom', unit: 'month', interval: 2, monthlyMode: 'day' }), TUE_2ND)).toBe('FREQ=MONTHLY;INTERVAL=2')
    expect(buildRrule(st({ freq: 'custom', unit: 'month', interval: 1, monthlyMode: 'weekday' }), TUE_2ND)).toBe('FREQ=MONTHLY;BYDAY=2TU')
    expect(buildRrule(st({ freq: 'custom', unit: 'month', interval: 1, monthlyMode: 'lastWeekday' }), TUE_2ND)).toBe('FREQ=MONTHLY;BYDAY=-1TU')
  })
  it('every N years', () => {
    expect(buildRrule(st({ freq: 'custom', unit: 'year', interval: 2 }), MON)).toBe('FREQ=YEARLY;INTERVAL=2')
  })
  it('interval of 1 omits INTERVAL', () => {
    expect(buildRrule(st({ freq: 'custom', unit: 'day', interval: 1 }), MON)).toBe('FREQ=DAILY')
  })
  it('an advanced raw rule overrides the builder, stripping RRULE:', () => {
    expect(buildRrule(st({ freq: 'custom', custom: 'RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=TU' }), MON)).toBe('FREQ=WEEKLY;COUNT=5;BYDAY=TU')
  })
  it('an empty custom builder still produces a rule (not null)', () => {
    expect(buildRrule(st({ freq: 'custom', unit: 'week', interval: 1, byday: [] }), MON)).toBe('FREQ=WEEKLY;BYDAY=MO')
  })
})

describe('parseRepeat', () => {
  it('returns NO_REPEAT for empty input', () => {
    expect(parseRepeat(undefined)).toEqual(NO_REPEAT)
    expect(parseRepeat(null)).toEqual(NO_REPEAT)
    expect(parseRepeat('')).toEqual(NO_REPEAT)
  })
  it('parses the simple presets', () => {
    expect(parseRepeat('FREQ=DAILY')).toEqual(st({ freq: 'daily' }))
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toEqual(st({ freq: 'weekdays' }))
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=MO,TH')).toEqual(st({ freq: 'weekly', byday: ['MO', 'TH'] }))
    expect(parseRepeat('FREQ=MONTHLY')).toEqual(st({ freq: 'monthly' }))
  })
  it('parses interval rules into the custom builder', () => {
    expect(parseRepeat('FREQ=DAILY;INTERVAL=3')).toEqual(st({ freq: 'custom', unit: 'day', interval: 3 }))
    expect(parseRepeat('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')).toEqual(st({ freq: 'custom', unit: 'week', interval: 2, byday: ['TU', 'TH'] }))
    expect(parseRepeat('FREQ=MONTHLY;INTERVAL=2')).toEqual(st({ freq: 'custom', unit: 'month', interval: 2, monthlyMode: 'day' }))
    expect(parseRepeat('FREQ=MONTHLY;BYDAY=2TU')).toEqual(st({ freq: 'custom', unit: 'month', interval: 1, monthlyMode: 'weekday' }))
    expect(parseRepeat('FREQ=MONTHLY;BYDAY=-1TU')).toEqual(st({ freq: 'custom', unit: 'month', interval: 1, monthlyMode: 'lastWeekday' }))
    expect(parseRepeat('FREQ=YEARLY;INTERVAL=2')).toEqual(st({ freq: 'custom', unit: 'year', interval: 2 }))
  })
  it('preserves bounded / unrepresentable rules as advanced custom', () => {
    const parsed = parseRepeat('FREQ=WEEKLY;COUNT=5;BYDAY=TU')
    expect(parsed.freq).toBe('custom')
    expect(parsed.custom).toBe('FREQ=WEEKLY;COUNT=5;BYDAY=TU')
  })
  it('round-trips presets + custom-builder rules through buildRrule', () => {
    const rules = [
      'FREQ=DAILY',
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      'FREQ=WEEKLY;BYDAY=MO,TH',
      'FREQ=MONTHLY',
      'FREQ=DAILY;INTERVAL=3',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
      'FREQ=MONTHLY;INTERVAL=2',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYDAY=-1TU',
      'FREQ=YEARLY;INTERVAL=2',
    ]
    for (const rule of rules) expect(buildRrule(parseRepeat(rule), TUE_2ND)).toBe(rule)
  })
})

describe('describeRrule', () => {
  it('describes presets and intervals in plain English', () => {
    expect(describeRrule(null, MON)).toBe('Does not repeat')
    expect(describeRrule('FREQ=DAILY', MON)).toBe('Every day')
    expect(describeRrule('FREQ=DAILY;INTERVAL=3', MON)).toBe('Every 3 days')
    expect(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', MON)).toBe('Every weekday (Mon–Fri)')
    expect(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', MON)).toBe('Every 2 weeks on Tue, Thu')
    expect(describeRrule('FREQ=MONTHLY;BYDAY=2TU', MON)).toBe('Every month on the second Tuesday')
    expect(describeRrule('FREQ=MONTHLY;BYDAY=-1FR', MON)).toBe('Every month on the last Friday')
    expect(describeRrule('FREQ=YEARLY;INTERVAL=2', MON)).toBe('Every 2 years')
  })
  it('appends a COUNT and falls back to the raw rule when unrecognised', () => {
    expect(describeRrule('FREQ=DAILY;COUNT=5', MON)).toBe('Every day, 5 times')
    expect(describeRrule('FREQ=HOURLY', MON)).toBe('FREQ=HOURLY')
  })
})

describe('helpers', () => {
  it('weekdayCode maps a date to its RRULE code', () => {
    expect(weekdayCode(MON)).toBe('MO')
  })
  it('nthWeekdayOfMonth finds which occurrence of its weekday a date is', () => {
    expect(nthWeekdayOfMonth(TUE_2ND)).toBe(2) // 2026-06-09 is the 2nd Tuesday
    expect(nthWeekdayOfMonth(new Date('2026-06-02T12:00:00'))).toBe(1) // 1st Tuesday
  })
})
