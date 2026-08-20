import { renderHook, waitFor } from '@testing-library/react'
import { useCountdowns } from './countdowns'
import { emit } from './bus'

// A rhythm change reaches more than the rhythms screen.
//
// Every rhythm mutation emits 'rhythms', and the rhythms hooks listen for it — but the
// surfaces a rhythm FEEDS listened only to their own topic. So completing the air filter
// refreshed the register and left the countdown next to it still counting down to the date
// that had just been superseded, until the page was reloaded by hand.
//
// A completion rhythm's next due date is a countdown source, so the countdown feed has to
// treat a rhythm change as its own. (The calendar has the same relationship through
// booking, which creates a real event — the same reason the agenda already refetches on
// 'meals'.)

let listCalls = 0

beforeEach(() => {
  listCalls = 0
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/countdowns')) {
      listCalls += 1
      return { ok: true, json: async () => ({ countdowns: [], sleeps: false, birthdayHorizonDays: 30 }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
})

describe('countdowns follow rhythms', () => {
  it('refetches when a rhythm changes, not only when a countdown does', async () => {
    renderHook(() => useCountdowns())
    await waitFor(() => expect(listCalls).toBe(1))

    emit('rhythms')
    await waitFor(() => expect(listCalls).toBe(2))
  })

  it('still refetches on its own topic', async () => {
    renderHook(() => useCountdowns())
    await waitFor(() => expect(listCalls).toBe(1))

    emit('countdowns')
    await waitFor(() => expect(listCalls).toBe(2))
  })

  it('ignores a topic it has nothing to do with', async () => {
    renderHook(() => useCountdowns())
    await waitFor(() => expect(listCalls).toBe(1))

    emit('recipes')
    // Nothing to wait for, so give a stray refetch a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 20))
    expect(listCalls).toBe(1)
  })
})
