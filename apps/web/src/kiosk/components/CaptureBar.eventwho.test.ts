import { describe, it, expect } from 'vitest'
import { resolveEventPersonId } from './CaptureBar'

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
