import { describe, it, expect } from 'vitest'
import { resolveEventPersonId, seedEventViewer } from './CaptureBar'

// When the "add anything" bar creates an event, the owner should default to the
// logged-in viewer UNLESS the phrasing named someone else ("dentist for George").
describe('resolveEventPersonId — capture-bar event owner', () => {
  const persons = [
    { id: 'p-jerry', name: 'Jerry' },
    { id: 'p-george', name: 'George' },
  ]
  const viewer = 'p-jerry'

  it('defaults to the viewer when no person was named', () => {
    expect(resolveEventPersonId(null, persons, viewer)).toBe('p-jerry')
  })

  it('respects an explicitly named person (case-insensitive)', () => {
    expect(resolveEventPersonId('George', persons, viewer)).toBe('p-george')
    expect(resolveEventPersonId('george', persons, viewer)).toBe('p-george')
  })

  it('does not force the viewer when a name was stated but does not match a member', () => {
    expect(resolveEventPersonId('Newman', persons, viewer)).toBeNull()
  })

  it('returns null when no name and the viewer has not loaded yet', () => {
    expect(resolveEventPersonId(null, persons, null)).toBeNull()
  })
})

// The picker must SHOW the viewer as the default (not "Nobody") for a freshly-parsed
// event, so the visible selection matches what commit() would save.
describe('seedEventViewer — default the event picker to the viewer', () => {
  const ev = (personName: string | null) => ({ kind: 'event' as const, title: 'Dentist', startsAt: '2026-07-23T17:00:00', allDay: false, personName, rrule: null, scheduleLabel: 'Thu, Jul 23', whenLabel: '5:00 PM' })

  it('fills in the viewer name when the event named nobody', () => {
    expect(seedEventViewer(ev(null), 'Jerry')).toMatchObject({ personName: 'Jerry' })
  })

  it('leaves an explicitly named person alone', () => {
    expect(seedEventViewer(ev('George'), 'Jerry')).toMatchObject({ personName: 'George' })
  })

  it('does nothing when the viewer has not loaded', () => {
    expect(seedEventViewer(ev(null), null)).toMatchObject({ personName: null })
  })

  it('ignores non-event intents', () => {
    const grocery = { kind: 'grocery' as const, title: 'Milk', quantity: null, listName: null }
    expect(seedEventViewer(grocery as never, 'Jerry')).toBe(grocery)
  })

  it('passes through null', () => {
    expect(seedEventViewer(null, 'Jerry')).toBeNull()
  })
})
