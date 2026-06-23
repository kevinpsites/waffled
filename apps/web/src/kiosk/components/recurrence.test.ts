import { buildRrule, parseRepeat, NO_REPEAT, weekdayCode, type RepeatState } from './recurrence'

const st = (over: Partial<RepeatState>): RepeatState => ({ ...NO_REPEAT, ...over })

describe('buildRrule', () => {
  it('returns null for none', () => {
    expect(buildRrule(st({ freq: 'none' }), 'MO')).toBeNull()
  })

  it('builds daily', () => {
    expect(buildRrule(st({ freq: 'daily' }), 'MO')).toBe('FREQ=DAILY')
  })

  it('builds weekdays', () => {
    expect(buildRrule(st({ freq: 'weekdays' }), 'MO')).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  })

  it('builds weekly with the default weekday when none selected', () => {
    expect(buildRrule(st({ freq: 'weekly', byday: [] }), 'WE')).toBe('FREQ=WEEKLY;BYDAY=WE')
  })

  it('builds weekly with selected days', () => {
    expect(buildRrule(st({ freq: 'weekly', byday: ['MO', 'TH'] }), 'WE')).toBe('FREQ=WEEKLY;BYDAY=MO,TH')
  })

  it('builds monthly', () => {
    expect(buildRrule(st({ freq: 'monthly' }), 'MO')).toBe('FREQ=MONTHLY')
  })

  it('passes a custom rule through, stripping RRULE: prefix', () => {
    expect(buildRrule(st({ freq: 'custom', custom: 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' }), 'MO')).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'
    )
  })

  it('treats an empty custom rule as non-recurring', () => {
    expect(buildRrule(st({ freq: 'custom', custom: '   ' }), 'MO')).toBeNull()
  })
})

describe('parseRepeat', () => {
  it('returns NO_REPEAT for empty input', () => {
    expect(parseRepeat(undefined)).toEqual(NO_REPEAT)
    expect(parseRepeat(null)).toEqual(NO_REPEAT)
    expect(parseRepeat('')).toEqual(NO_REPEAT)
  })

  it('parses daily', () => {
    expect(parseRepeat('FREQ=DAILY')).toEqual({ freq: 'daily', byday: [], custom: '' })
  })

  it('parses the weekday set as weekdays', () => {
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toEqual({ freq: 'weekdays', byday: [], custom: '' })
  })

  it('parses weekly with specific days', () => {
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=MO,TH')).toEqual({ freq: 'weekly', byday: ['MO', 'TH'], custom: '' })
  })

  it('parses monthly', () => {
    expect(parseRepeat('FREQ=MONTHLY')).toEqual({ freq: 'monthly', byday: [], custom: '' })
  })

  it('falls back to custom for rules the picker cannot represent', () => {
    const parsed = parseRepeat('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')
    expect(parsed.freq).toBe('custom')
    expect(parsed.custom).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')
  })

  it('round-trips daily/weekdays/weekly/monthly through buildRrule', () => {
    for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'FREQ=WEEKLY;BYDAY=MO,TH', 'FREQ=MONTHLY']) {
      expect(buildRrule(parseRepeat(rule), 'MO')).toBe(rule)
    }
  })
})

describe('weekdayCode', () => {
  it('maps a date to its RRULE weekday code', () => {
    // 2026-06-22 is a Monday.
    expect(weekdayCode(new Date('2026-06-22T12:00:00'))).toBe('MO')
  })
})
