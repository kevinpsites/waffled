import { renderHook } from '@testing-library/react'
import { useGoalActivity } from './goals'

const activityA = { startDate: '2026-01-01', endDate: null, today: '2026-07-17', days: [{ dateKey: '2026-07-17', total: 2.5, perMember: {} }] }

describe('useGoalActivity', () => {
  it('clears the previous goal\'s activity as soon as the id changes, not only once the new fetch resolves', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => activityA })) as unknown as typeof fetch
    const { result, rerender } = renderHook(({ id }) => useGoalActivity(id), { initialProps: { id: 'g1' } })
    await vi.waitFor(() => expect(result.current.activity).not.toBeNull())
    expect(result.current.activity?.days[0].total).toBe(2.5)

    // Switch to a different goal whose fetch never resolves. A hook that only
    // clears `activity` inside the `.then()` continuation would keep goal A's
    // data sitting in state (and thus readable/renderable by any consumer) for
    // as long as goal B's fetch takes, not just a single render.
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    rerender({ id: 'g2' })

    expect(result.current.activity).toBeNull()
    expect(result.current.loading).toBe(true)
  })
})
