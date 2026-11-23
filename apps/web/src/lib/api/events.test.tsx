import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useEvent, useEventsRange, useEventsToday, eventsApi, type AgendaEvent } from './events'
import { emit } from './bus'
import { localToday } from './client'

function restEvent(id: string, startsAt = '2026-06-24T21:00:00Z'): AgendaEvent {
  return {
    id, title: `rest ${id}`, startsAt, endsAt: null, allDay: false, location: null,
    personId: null, personName: null, personColor: null, personEmoji: null, participants: [],
  }
}

let calls: Array<{ url: string; method: string }> = []
let nextEvents: AgendaEvent[] = []
let failNext = false
let status = 200

beforeEach(() => {
  calls = []
  nextEvents = []
  failNext = false
  status = 200
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (failNext) return { ok: false, status, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => ({ events: nextEvents, event: nextEvents[0], date: '', from: '', to: '' }) } as Response
  }) as unknown as typeof fetch
})

const gets = () => calls.filter((c) => c.method === 'GET')

describe('events reads over REST', () => {
  it('useEventsRange calls GET /api/events?from&to and exposes the rows', async () => {
    nextEvents = [restEvent('r1')]
    const { result } = renderHook(() => useEventsRange('2026-06-01', '2026-07-01'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(gets()[0].url).toContain('/api/events?from=2026-06-01&to=2026-07-01')
    expect(result.current.events.map((e) => e.id)).toEqual(['r1'])
  })

  it('useEventsToday calls GET /api/events/today?date=', async () => {
    nextEvents = [restEvent('t1')]
    const { result } = renderHook(() => useEventsToday())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(gets()[0].url).toContain(`/api/events/today?date=${localToday()}`)
    expect(result.current.events.map((e) => e.id)).toEqual(['t1'])
  })

  it('refetches when the events bus topic fires', async () => {
    nextEvents = [restEvent('r1')]
    const { result } = renderHook(() => useEventsRange('2026-06-01', '2026-07-01'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    nextEvents = [restEvent('r2')]
    act(() => emit('events'))
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(['r2']))
    expect(gets()).toHaveLength(2)
  })

  it('reports an error with nothing on screen, but keeps rows after a failed refetch', async () => {
    failNext = true
    const first = renderHook(() => useEventsRange('2026-06-01', '2026-07-01'))
    await waitFor(() => expect(first.result.current.error).toBe(true))
    failNext = false
    nextEvents = [restEvent('r1')]
    const { result } = renderHook(() => useEventsRange('2026-06-01', '2026-07-01'))
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    failNext = true
    act(() => emit('events'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.events).toHaveLength(1)
    expect(result.current.error).toBe(false)
  })
})

describe('events writes over REST', () => {
  it('create/update/delete hit POST/PATCH/DELETE and publish the events topic', async () => {
    const seen = vi.fn()
    window.addEventListener('waffled:events', seen)
    nextEvents = [restEvent('e1')]
    await eventsApi.createEvent({ title: 'x', startsAt: '2026-06-24T21:00:00Z' })
    await eventsApi.updateEvent('e1', { title: 'y' })
    await eventsApi.deleteEvent('e1')
    window.removeEventListener('waffled:events', seen)
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, '')}`)).toEqual([
      'POST /api/events',
      'PATCH /api/events/e1',
      'DELETE /api/events/e1',
    ])
    expect(seen).toHaveBeenCalledTimes(3)
  })
})

describe('useEvent', () => {
  it('refetches on the events topic and keeps the event when that refetch 404s', async () => {
    nextEvents = [restEvent('e1')]
    const { result } = renderHook(() => useEvent('e1'))
    await waitFor(() => expect(result.current.event?.title).toBe('rest e1'))
    nextEvents = [{ ...restEvent('e1'), title: 'edited' }]
    act(() => emit('events'))
    await waitFor(() => expect(result.current.event?.title).toBe('edited'))

    failNext = true
    status = 404
    act(() => emit('events'))
    await waitFor(() => expect(gets()).toHaveLength(3))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.event?.title).toBe('edited')
    expect(result.current.notFound).toBe(false)
    expect(result.current.loading).toBe(false)
  })
})
