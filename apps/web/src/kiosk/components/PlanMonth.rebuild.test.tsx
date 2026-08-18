// "Plan my month" writes 4–6 weeks of dinners, but a grocery rebuild is scoped to ONE
// week (`rebuildGroceryFromWeek` covers weekStart..weekStart+6). Rebuilding once with the
// month start therefore built at most the first week — and, before the server learned to
// snap, not even that: it stamped rows on the 1st of the month, a key no board asks for.
//
// The rule pinned here: applying a month rebuilds EVERY household week it touched, once
// each. Week boundaries follow the household's first-day-of-week, because a Sunday-based
// grouping leaves a monday household with an uncovered week.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PlanMonth } from './PlanMonth'
import { weekStartsToRebuild } from './PlanMonth'
import { TopbarSlotProvider } from '../topbar-slot'

const ok = (body: unknown) => ({ ok: true, json: async () => body })

// Wednesdays across September 2026 — four distinct weeks under either preference.
// (Sep 1 2026 is a TUESDAY, so the month start is never a week start.)
const NIGHTS = ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23']

type Sent = { method: string; url: string }

function mockApi(weekStartPref: 'sunday' | 'monday', dates: string[] = NIGHTS) {
  const sent: Sent[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    sent.push({ method, url: u })
    if (u.includes('/api/meals/plan-month')) {
      return ok({
        start: '2026-09-01',
        mealType: 'dinner',
        via: 'test',
        existing: [],
        suggestions: dates.map((date, i) => ({ date, title: `Dish ${i + 1}`, recipeId: null, emoji: null, minutes: 30, note: '' })),
      })
    }
    if (u.includes('/api/household')) {
      return ok({ provisioned: true, household: { id: 'h', name: 'Sites', timezone: 'America/Chicago', weekStart: weekStartPref }, person: null, memberships: [], pendingInvites: [] })
    }
    if (u.includes('/api/lists/grocery/rebuild')) return ok({ rebuilt: 1, board: { items: [] } })
    return ok({ persons: [], recipes: [], entries: [] })
  }) as unknown as typeof fetch
  return sent
}

const rebuildWeeks = (sent: Sent[]) =>
  sent.filter((s) => s.url.includes('/api/lists/grocery/rebuild')).map((s) => new URL(s.url, 'http://x').searchParams.get('weekStart'))

// Draft the month, apply it, and wait for apply to FINISH. The barrier matters:
// `applyAll` calls onApplied() only after the rebuild loop, so waiting on it is the
// difference between "at least one rebuild has landed" and "these are all of them" —
// a waitFor on the call list alone goes green on the first call and can never see a
// redundant second one.
async function planAndApply(): Promise<void> {
  const onApplied = vi.fn()
  render(
    <TopbarSlotProvider>
      <PlanMonth monthStart="2026-09-01" onClose={() => {}} onApplied={onApplied} />
    </TopbarSlotProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: /plan my month/i }))
  fireEvent.click(await screen.findByRole('button', { name: /save month & build list/i }))
  await waitFor(() => expect(onApplied).toHaveBeenCalled())
}

describe('PlanMonth — the grocery rebuild covers the whole month', () => {
  it('rebuilds every household week the plan touches, exactly once', async () => {
    const sent = mockApi('sunday')
    await planAndApply()
    // Sundays: Aug 30 / Sep 6 / Sep 13 / Sep 20 — the keys the grocery board asks for.
    expect(rebuildWeeks(sent)).toEqual(['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20'])
  })

  it('does not fire a second rebuild for two nights in the same week', async () => {
    const sent = mockApi('sunday', ['2026-09-08', '2026-09-09', '2026-09-10'])
    await planAndApply()
    expect(rebuildWeeks(sent)).toEqual(['2026-09-06'])
  })

  it('follows a monday household’s week boundaries', async () => {
    const sent = mockApi('monday')
    await planAndApply()
    expect(rebuildWeeks(sent)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'])
  })
})

// The week derivation itself, where the sunday/monday matrix is cheap to pin down.
describe('weekStartsToRebuild', () => {
  it('collapses a week of dates to its one start (sunday)', () => {
    expect(weekStartsToRebuild(['2026-09-06', '2026-09-09', '2026-09-12'], 'sunday')).toEqual(['2026-09-06'])
  })

  it('splits a Sunday off the week before it, for a monday household', () => {
    // Sun Sep 6 closes the week that began Mon Aug 31; Mon Sep 7 opens the next one.
    expect(weekStartsToRebuild(['2026-09-06', '2026-09-07'], 'monday')).toEqual(['2026-08-31', '2026-09-07'])
    // ...and a sunday household calls those two different weeks the other way round.
    expect(weekStartsToRebuild(['2026-09-06', '2026-09-07'], 'sunday')).toEqual(['2026-09-06'])
  })

  it('returns weeks in date order, with no duplicates, and tolerates an empty plan', () => {
    expect(weekStartsToRebuild(['2026-09-23', '2026-09-02', '2026-09-09', '2026-09-02'], 'sunday')).toEqual([
      '2026-08-30',
      '2026-09-06',
      '2026-09-20',
    ])
    expect(weekStartsToRebuild([], 'sunday')).toEqual([])
  })
})
