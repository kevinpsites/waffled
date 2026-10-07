import { render, waitFor } from '@testing-library/react'
import { ScheduleModal } from './ScheduleModal'
import { MealBuilderScheduleModal } from './MealBuilderScheduleModal'
import type { Meal, RecipeDetail } from '../../lib/api'

// "This week" has to mean the same seven days everywhere. These two schedulers cut
// their week on Sunday no matter what the household said, while the meal planner's
// grid follows the setting — so on a Sunday in a Monday household the planner showed
// that day as the LAST day of the current week and these pickers showed it as the
// FIRST. Scheduling a recipe from here then landed it in a different week than the
// one the planner was showing, and the grocery list is keyed by the household's week,
// so the night could fall outside the week that got shopped for.

function mockApi(weekStart: 'sunday' | 'monday') {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          household: { id: 'h1', name: 'Home', weekStart, timezone: 'America/Chicago' },
          person: null, memberships: [], pendingInvites: [],
        }),
      }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const recipe = { id: 'r1', title: 'Ragu' } as unknown as RecipeDetail
const meal = { id: 'm1', name: 'Sunday roast', emojis: ['🍖'], recipeCount: 2, servings: 4 } as unknown as Meal

// The two-letter heading on the first day button — the day the picker's week starts on.
const firstDow = (selector: string) =>
  document.querySelector(`${selector} span`)?.textContent?.trim()

describe('the recipe schedulers cut their week where the household says', () => {
  it('ScheduleModal leads with Monday for a monday household', async () => {
    mockApi('monday')
    render(<ScheduleModal recipe={recipe} onClose={() => {}} onScheduled={() => {}} />)
    await waitFor(() => expect(firstDow('.sched-day')).toBe('Mo'))
  })

  it('ScheduleModal still leads with Sunday for a sunday household', async () => {
    mockApi('sunday')
    render(<ScheduleModal recipe={recipe} onClose={() => {}} onScheduled={() => {}} />)
    await waitFor(() => expect(firstDow('.sched-day')).toBe('Su'))
  })

  it('MealBuilderScheduleModal leads with Monday for a monday household', async () => {
    mockApi('monday')
    render(<MealBuilderScheduleModal meal={meal} onClose={() => {}} onScheduled={() => {}} />)
    await waitFor(() => expect(firstDow('.mb-sched-day')).toBe('Mo'))
  })

  it('MealBuilderScheduleModal still leads with Sunday for a sunday household', async () => {
    mockApi('sunday')
    render(<MealBuilderScheduleModal meal={meal} onClose={() => {}} onScheduled={() => {}} />)
    await waitFor(() => expect(firstDow('.mb-sched-day')).toBe('Su'))
  })

  it('offers seven consecutive days from that cut', async () => {
    mockApi('monday')
    render(<ScheduleModal recipe={recipe} onClose={() => {}} onScheduled={() => {}} />)
    await waitFor(() => expect(firstDow('.sched-day')).toBe('Mo'))
    const dows = Array.from(document.querySelectorAll('.sched-day span:first-child')).map((e) => e.textContent?.trim())
    expect(dows).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
  })
})
