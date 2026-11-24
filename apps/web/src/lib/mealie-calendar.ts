// Mealie meal-plan entries as synthetic all-day calendar events.
import type { AgendaEvent } from './api'
import type { MealieEntry } from './api/mealie'

// The web editor stores an all-day event at local noon of its day; noon stays on
// the right date through DST shifts, so match it rather than using midnight.
function noonIn(date: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 12)
  const offsetAt = (t: number) => {
    let parts: Record<string, number> = {}
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)]))
    } catch {
      return 0
    }
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - t
  }
  const first = guess - offsetAt(guess)
  return new Date(guess - offsetAt(first)).toISOString()
}

export function mealieEntriesToEvents(entries: MealieEntry[], tz: string): AgendaEvent[] {
  return entries.map((e) => ({
    id: `mealie:${e.id}`,
    title: `🍽️ ${e.title}`,
    startsAt: noonIn(e.date, tz),
    endsAt: null,
    allDay: true,
    location: null,
    personId: null,
    personName: null,
    personColor: null,
    personEmoji: null,
    participants: [],
    origin: 'mealie_plan',
    originRefId: e.recipe?.slug ?? null,
  }))
}

export function hideMealMirrors(events: AgendaEvent[]): AgendaEvent[] {
  return events.filter((e) => e.origin !== 'meal_plan' && e.origin !== 'meal_prep')
}
