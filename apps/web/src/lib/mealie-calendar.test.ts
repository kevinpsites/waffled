import { describe, it, expect } from 'vitest'
import { mealieEntriesToEvents, hideMealMirrors } from './mealie-calendar'
import { localDate } from '../kiosk/components/cal-utils'
import type { AgendaEvent } from './api'

const entry = (id: number, date: string, slug: string | null) => ({
  id, date, entryType: 'dinner', title: 'Tacos',
  recipe: slug ? { id: 'r', slug, name: 'Tacos', imageUrl: null } : null,
})

describe('mealieEntriesToEvents', () => {
  it('maps entries to all-day meal events', () => {
    const [a, b] = mealieEntriesToEvents([entry(7, '2026-11-24', 'tacos'), entry(8, '2026-11-25', null)], 'UTC')
    expect(a).toMatchObject({
      id: 'mealie:7', title: '🍽️ Tacos', allDay: true, origin: 'mealie_plan',
      originRefId: 'tacos', participants: [], endsAt: null, location: null, personId: null,
    })
    expect(b.originRefId).toBeNull()
  })

  it('places the instant on the entry date in a non-UTC household zone', () => {
    for (const tz of ['Pacific/Auckland', 'America/Los_Angeles']) {
      const [e] = mealieEntriesToEvents([entry(1, '2026-03-08', 'x')], tz)
      expect(localDate(e.startsAt, tz)).toBe('2026-03-08')
    }
  })
})

describe('hideMealMirrors', () => {
  it('drops only meal_plan and meal_prep', () => {
    const ev = (id: string, origin: string | null) => ({ id, origin }) as unknown as AgendaEvent
    const out = hideMealMirrors([ev('a', 'meal_plan'), ev('b', 'meal_prep'), ev('c', 'rhythm'), ev('d', null)])
    expect(out.map((e) => e.id)).toEqual(['c', 'd'])
  })
})
