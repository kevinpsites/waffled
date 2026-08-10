import { describe, it, expect } from 'vitest'
import { wbIsOnline, WB_OFFLINE_AFTER_MS } from './waffledBiteStatus'

const NOW = new Date('2026-07-23T12:00:00.000Z').getTime()

describe('wbIsOnline', () => {
  it('is offline when the device has never reported in', () => {
    expect(wbIsOnline(null, NOW)).toBe(false)
  })

  it('is online when last seen right now', () => {
    expect(wbIsOnline(new Date(NOW).toISOString(), NOW)).toBe(true)
  })

  it('is online when last seen just under the threshold ago', () => {
    const seen = new Date(NOW - (WB_OFFLINE_AFTER_MS - 1000)).toISOString()
    expect(wbIsOnline(seen, NOW)).toBe(true)
  })

  it('is offline when last seen just over the threshold ago', () => {
    const seen = new Date(NOW - (WB_OFFLINE_AFTER_MS + 1000)).toISOString()
    expect(wbIsOnline(seen, NOW)).toBe(false)
  })

  it('is offline on an unparseable timestamp', () => {
    expect(wbIsOnline('not-a-date', NOW)).toBe(false)
  })
})
