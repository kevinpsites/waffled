import { describe, it, expect } from 'vitest'
import { clockLabel } from '../src/platform/clock'

// One spelling of a stored "HH:MM" as the time people say.
describe('clockLabel', () => {
  it('reads an afternoon time on the 12-hour clock', () => {
    expect(clockLabel('17:00')).toBe('5:00 PM')
  })

  it('keeps the minutes and drops a leading zero on the hour', () => {
    expect(clockLabel('09:05')).toBe('9:05 AM')
  })

  it('says 12 for midnight and noon', () => {
    expect(clockLabel('00:30')).toBe('12:30 AM')
    expect(clockLabel('12:15')).toBe('12:15 PM')
  })

  it('ignores trailing seconds', () => {
    expect(clockLabel('18:30:00')).toBe('6:30 PM')
  })

  it('hands back anything that is not a time unchanged', () => {
    expect(clockLabel('soon')).toBe('soon')
  })
})
