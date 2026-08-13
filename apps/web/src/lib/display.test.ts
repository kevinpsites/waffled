// Household display settings — the event-chip style resolver + root stamping.
import { afterEach, describe, expect, it } from 'vitest'
import { eventStyle, applyEventStyle } from './display'
import type { Household } from './api'

const h = (settings?: Household['settings']) =>
  ({ id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday', location: null, ownerPersonId: null, settings }) as Household

describe('eventStyle', () => {
  it('defaults to solid (no household, no settings, unknown values)', () => {
    expect(eventStyle(null)).toBe('solid')
    expect(eventStyle(undefined)).toBe('solid')
    expect(eventStyle(h())).toBe('solid')
    expect(eventStyle(h({}))).toBe('solid')
    expect(eventStyle(h({ display: {} }))).toBe('solid')
    expect(eventStyle(h({ display: { eventStyle: 'plaid' } } as unknown as Household['settings']))).toBe('solid')
  })

  it('honors an explicit tinted choice', () => {
    expect(eventStyle(h({ display: { eventStyle: 'tinted' } }))).toBe('tinted')
    expect(eventStyle(h({ display: { eventStyle: 'solid' } }))).toBe('solid')
  })
})

describe('applyEventStyle', () => {
  afterEach(() => document.documentElement.removeAttribute('data-ev-style'))

  it('stamps data-ev-style on the document root', () => {
    applyEventStyle('tinted')
    expect(document.documentElement.getAttribute('data-ev-style')).toBe('tinted')
    applyEventStyle('solid')
    expect(document.documentElement.getAttribute('data-ev-style')).toBe('solid')
  })
})
