import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useListDetail } from './grocery'

// Lists poll every ~20s so another family member's edits appear. A poll that was already
// in flight when you delete something answers with the pre-delete rows — and since the
// delete is optimistic with no success-path refetch, that answer used to put the item
// you just deleted back on screen until the next tick, up to a full interval later.

type Deferred = { resolve: (items: unknown[]) => void }

describe('useListDetail vs an in-flight poll', () => {
  let pending: Deferred[] = []

  beforeEach(() => {
    pending = []
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          pending.push({
            resolve: (items) => resolve({ ok: true, json: async () => ({ items }) } as Response),
          })
        }),
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const rows = (...ids: string[]) =>
    ids.map((id) => ({ id, name: id, quantity: null, checked: false, section: null, store: null }))

  it('does not resurrect an item deleted while the poll was in flight', async () => {
    const { result } = renderHook(() => useListDetail('l1'))

    await act(async () => { pending[0].resolve(rows('a', 'b')) })
    await waitFor(() => expect(result.current.items).toHaveLength(2))

    // a poll goes out…
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(pending).toHaveLength(2))

    // …the user deletes "a" while it's still in the air (optimistic local removal)…
    await act(async () => {
      result.current.setItems((prev) => prev.filter((i) => i.id !== 'a'))
    })
    expect(result.current.items.map((i) => i.id)).toEqual(['b'])

    // …and the poll answers with what the server knew BEFORE the delete.
    await act(async () => { pending[1].resolve(rows('a', 'b')) })

    expect(result.current.items.map((i) => i.id)).toEqual(['b'])
  })

  it('still accepts a poll that started after the local change', async () => {
    // The guard must not deafen the hook permanently — cross-device updates are the
    // whole point of the poll.
    const { result } = renderHook(() => useListDetail('l1'))
    await act(async () => { pending[0].resolve(rows('a')) })
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await act(async () => {
      result.current.setItems((prev) => prev.filter((i) => i.id !== 'a'))
    })
    await act(async () => { result.current.refetch() })
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => { pending[1].resolve(rows('a', 'c')) })

    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'c'])
  })
})
