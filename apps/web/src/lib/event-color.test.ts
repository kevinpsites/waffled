// Whole-family events get their own household color so the calendar reads at a
// glance: "everyone" vs "one person" vs "some of us" (which keeps the owner's color).
import { describe, it, expect } from 'vitest'
import { DEFAULT_FAMILY_COLOR, UNASSIGNED_COLOR, familyColorHex, isFamilyEvent, eventColor } from './event-color'
import type { Household } from './api/persons'

const household = (familyColor?: string): Household =>
  ({
    id: 'h1',
    name: 'Sites',
    timezone: 'America/Chicago',
    weekStart: 'sunday',
    location: null,
    ownerPersonId: null,
    settings: familyColor ? { display: { familyColorHex: familyColor } } : {},
  }) as Household

const ev = (o: { personId?: string | null; personColor?: string | null; participants?: { id: string }[] }) =>
  ({
    personId: o.personId ?? null,
    personColor: o.personColor ?? null,
    participants: (o.participants ?? []).map((p) => ({ id: p.id, name: '', colorHex: null, avatarEmoji: null })),
  }) as never

describe('familyColorHex', () => {
  it('reads settings.display.familyColorHex with a sensible default', () => {
    expect(familyColorHex(household('#123456'))).toBe('#123456')
    expect(familyColorHex(household())).toBe(DEFAULT_FAMILY_COLOR)
    expect(familyColorHex(null)).toBe(DEFAULT_FAMILY_COLOR)
  })

  it('ignores a non-hex value', () => {
    expect(familyColorHex({ settings: { display: { familyColorHex: 'red' } } } as unknown as Household)).toBe(DEFAULT_FAMILY_COLOR)
  })
})

describe('isFamilyEvent', () => {
  const members = ['a', 'b', 'c']

  it('is true only when the people cover every household member', () => {
    expect(isFamilyEvent(ev({ participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), members)).toBe(true)
    expect(isFamilyEvent(ev({ participants: [{ id: 'a' }, { id: 'b' }] }), members)).toBe(false)
    expect(isFamilyEvent(ev({ participants: [{ id: 'a' }] }), members)).toBe(false)
    expect(isFamilyEvent(ev({}), members)).toBe(false)
  })

  it('counts the color owner (personId) toward coverage', () => {
    expect(isFamilyEvent(ev({ personId: 'c', participants: [{ id: 'a' }, { id: 'b' }] }), members)).toBe(true)
  })

  it('never fires for a one-person household (nothing to distinguish)', () => {
    expect(isFamilyEvent(ev({ participants: [{ id: 'a' }] }), ['a'])).toBe(false)
  })
})

describe('eventColor', () => {
  const members = ['a', 'b']

  it('uses the family color for whole-family events', () => {
    const e = ev({ personColor: '#2F7FED', participants: [{ id: 'a' }, { id: 'b' }] })
    expect(eventColor(e, members, household('#ABCDEF'))).toBe('#ABCDEF')
    expect(eventColor(e, members, household())).toBe(DEFAULT_FAMILY_COLOR)
  })

  it('keeps the owner color for partial-family events, grey when unassigned', () => {
    expect(eventColor(ev({ personColor: '#2F7FED', participants: [{ id: 'a' }] }), members, household())).toBe('#2F7FED')
    expect(eventColor(ev({}), members, household())).toBe(UNASSIGNED_COLOR)
  })

  it('falls back to the owner color while members are still loading', () => {
    expect(eventColor(ev({ personColor: '#2F7FED', participants: [{ id: 'a' }, { id: 'b' }] }), [], household('#ABCDEF'))).toBe('#2F7FED')
  })
})
