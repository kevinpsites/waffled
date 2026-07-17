// Unit tests for the digest renderer + scheduler timing — no DB, no network.
import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { renderDigest, type DigestData } from '../src/modules/email/templates'
import { isDigestDue, isoWeekKey } from '../src/modules/email/weekly-digest.service'

const data: DigestData = {
  householdName: 'Sites',
  weekLabel: 'Jul 7–13',
  sections: ['calendar', 'meals', 'grocery', 'chores'],
  events: [{ day: 'Mon 7', time: '9:00 AM', title: 'Dentist' }],
  meals: [{ day: 'Mon 7', mealType: 'dinner', title: 'Tacos' }],
  choresDue: 3,
  choresByPerson: [{ name: 'Kevin', count: 2 }, { name: 'Teen', count: 1 }],
  groceryOpen: 2,
  grocerySample: ['Milk', 'Eggs'],
}

describe('renderDigest', () => {
  it('includes each section and escapes the household name', () => {
    const { html, text } = renderDigest(data)
    expect(html).toContain('Dentist')
    expect(html).toContain('Tacos')
    expect(html).toContain('chores due this week')
    expect(html).toContain('Kevin: 2')
    expect(html).toContain('Milk, Eggs')
    // plaintext alternative present
    expect(text).toContain('CALENDAR')
    expect(text).toContain('Mon 7 · 9:00 AM — Dentist')
  })

  it('honors the sections preference (omits unselected blocks)', () => {
    const { html } = renderDigest({ ...data, sections: ['calendar'] })
    expect(html).toContain('Dentist')
    expect(html).not.toContain('Tacos') // meals omitted
    expect(html).not.toContain('grocery list')
  })

  it('escapes HTML in titles', () => {
    const { html } = renderDigest({ ...data, events: [{ day: 'Mon 7', time: '9:00 AM', title: '<script>x</script>' }] })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('scheduler timing', () => {
  it('is due only on the configured weekday at/after the hour', () => {
    // Monday 2026-07-06 08:30 local
    const mon0830 = DateTime.fromISO('2026-07-06T08:30', { zone: 'America/Chicago' })
    expect(isDigestDue(mon0830, 1, 7)).toBe(true) // Mon, 08 >= 07
    expect(isDigestDue(mon0830, 1, 9)).toBe(false) // before 9
    expect(isDigestDue(mon0830, 2, 7)).toBe(false) // wrong weekday (Tue)
  })

  it('produces a stable ISO-week dedupe key', () => {
    const dt = DateTime.fromISO('2026-07-06T08:00', { zone: 'America/Chicago' })
    expect(isoWeekKey(dt)).toMatch(/^weekly_digest:2026-W\d{2}$/)
    // Same week, different day → same key.
    expect(isoWeekKey(dt.plus({ days: 2 }))).toBe(isoWeekKey(dt))
  })
})
