// Replica-trust arbitration in the events hooks. A wedged PowerSync engine once
// left an empty local replica driving the calendar while perfectly good REST data
// was discarded, so the kiosk rendered a blank month. These tests pin the rule:
// only a TRUSTED replica (completed sync + engine not stalled) may take over from
// REST; otherwise REST drives and local rows are at most a pre-REST paint.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useEventsRange, useEventsToday, type AgendaEvent } from './events'
import { localToday } from './client'
import { publishSyncHealth, __resetSyncHealthForTests, type SyncHealthSnapshot } from '../powersync/sync-health'
import type { LocalEventRow } from '../powersync/events-local'

// Controllable local watch — tests emit rows as if PowerSync had streamed them.
const watch = vi.hoisted(() => ({
  cbs: [] as Array<(rows: unknown[]) => void>,
  emit(rows: unknown[]) {
    for (const cb of [...this.cbs]) cb(rows)
  },
}))

vi.mock('../powersync/events-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../powersync/events-local')>()
  return {
    ...actual,
    getHouseholdTz: async () => 'UTC',
    watchAgendaRows: (onRows: (rows: unknown[]) => void) => {
      watch.cbs.push(onRows)
      return () => {
        watch.cbs = watch.cbs.filter((c) => c !== onRows)
      }
    },
  }
})

function localRow(id: string, startsAt = '2026-06-24T22:00:00Z'): LocalEventRow {
  return {
    id,
    title: `local ${id}`,
    description: null,
    location: null,
    starts_at: startsAt,
    ends_at: null,
    all_day: 0,
    person_id: null,
    origin: null,
    origin_ref_id: null,
    visibility: 'family',
    owner_person_id: null,
    person_name: null,
    person_color: null,
    person_emoji: null,
    participants_json: null,
  }
}

function restEvent(id: string, startsAt = '2026-06-24T21:00:00Z'): AgendaEvent {
  return {
    id,
    title: `rest ${id}`,
    startsAt,
    endsAt: null,
    allDay: false,
    location: null,
    personId: null,
    personName: null,
    personColor: null,
    personEmoji: null,
    participants: [],
  }
}

// Every /api/events* request parks here until the test resolves or fails it.
let fetchCalls: Array<{ url: string; ok: (events: AgendaEvent[]) => void; fail: () => void }> = []

beforeEach(() => {
  __resetSyncHealthForTests()
  watch.cbs = []
  fetchCalls = []
  globalThis.fetch = vi.fn(
    (url: RequestInfo | URL) =>
      new Promise<Response>((res) => {
        fetchCalls.push({
          url: String(url),
          ok: (events) => res({ ok: true, json: async () => ({ events, date: '', from: '', to: '' }) } as Response),
          fail: () => res({ ok: false, status: 500, json: async () => ({}) } as Response),
        })
      })
  ) as unknown as typeof fetch
})

const TRUSTED: SyncHealthSnapshot = { status: 'ok', hasSynced: true, lastSyncedAt: 1, restartCount: 0, lastRestartAt: null }

function renderRange() {
  return renderHook(() => useEventsRange('2000-01-01', '2100-01-01'))
}

async function watchArmed() {
  await waitFor(() => expect(watch.cbs.length).toBeGreaterThan(0))
}

describe('useEventsRange replica trust', () => {
  it('lets REST win when the replica is untrusted, even if local painted first', async () => {
    const { result } = renderRange()
    await watchArmed()
    act(() => watch.emit([localRow('l1')]))
    // A pre-REST paint is still allowed — better than a spinner.
    expect(result.current.events.map((e) => e.id)).toEqual(['l1'])
    await act(async () => fetchCalls[0].ok([restEvent('r1')]))
    expect(result.current.events.map((e) => e.id)).toEqual(['r1'])
    expect(result.current.error).toBe(false)
  })

  it('does not let a later untrusted local emission clobber a loaded REST result', async () => {
    const { result } = renderRange()
    await watchArmed()
    await act(async () => fetchCalls[0].ok([restEvent('r1')]))
    act(() => watch.emit([localRow('l1')]))
    expect(result.current.events.map((e) => e.id)).toEqual(['r1'])
  })

  it('lets a trusted replica take over and ignore the REST baseline', async () => {
    publishSyncHealth(TRUSTED)
    const { result } = renderRange()
    await watchArmed()
    act(() => watch.emit([localRow('l1')]))
    await act(async () => fetchCalls[0].ok([restEvent('r1')]))
    expect(result.current.events.map((e) => e.id)).toEqual(['l1'])
  })

  it('keeps untrusted local rows on screen when REST fails (never blank what we have)', async () => {
    const { result } = renderRange()
    await watchArmed()
    act(() => watch.emit([localRow('l1')]))
    await act(async () => fetchCalls[0].fail())
    expect(result.current.events.map((e) => e.id)).toEqual(['l1'])
    expect(result.current.error).toBe(false)
  })

  it('still reports an error when REST fails and there is nothing local', async () => {
    const { result } = renderRange()
    await watchArmed()
    await act(async () => fetchCalls[0].fail())
    expect(result.current.events).toEqual([])
    expect(result.current.error).toBe(true)
  })

  it('refetches over REST the moment replica trust flips to stalled', async () => {
    publishSyncHealth(TRUSTED)
    const { result } = renderRange()
    await watchArmed()
    act(() => watch.emit([localRow('l1')]))
    await act(async () => fetchCalls[0].ok([restEvent('stale')]))
    expect(result.current.events.map((e) => e.id)).toEqual(['l1'])
    // The engine wedges → the watchdog marks it stalled → REST must re-drive.
    act(() => publishSyncHealth({ ...TRUSTED, status: 'stalled', restartCount: 1, lastRestartAt: 2 }))
    await waitFor(() => expect(fetchCalls.length).toBe(2))
    await act(async () => fetchCalls[1].ok([restEvent('fresh')]))
    expect(result.current.events.map((e) => e.id)).toEqual(['fresh'])
  })

  it('lets the replica take the wheel back once the engine recovers', async () => {
    const { result } = renderRange()
    await watchArmed()
    await act(async () => fetchCalls[0].ok([restEvent('r1')]))
    act(() => publishSyncHealth(TRUSTED))
    await waitFor(() => expect(fetchCalls.length).toBe(2))
    act(() => watch.emit([localRow('l1')]))
    expect(result.current.events.map((e) => e.id)).toEqual(['l1'])
  })

  it('ignores health churn that does not change the trust verdict', async () => {
    renderRange()
    await watchArmed()
    await act(async () => fetchCalls[0].ok([restEvent('r1')]))
    // off → connecting → offline are all untrusted; no refetch storm.
    act(() => publishSyncHealth({ ...TRUSTED, status: 'connecting', hasSynced: false }))
    act(() => publishSyncHealth({ ...TRUSTED, status: 'offline', hasSynced: false }))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('useEventsToday replica trust', () => {
  it('an empty wedged replica must not blank the calendar — REST fills it', async () => {
    const { result } = renderHook(() => useEventsToday())
    await watchArmed()
    // The wedged engine's replica is empty: the watch streams zero rows.
    act(() => watch.emit([]))
    const today = localToday()
    await act(async () => fetchCalls[0].ok([restEvent('r1', `${today}T12:00:00Z`)]))
    expect(result.current.events.map((e) => e.id)).toEqual(['r1'])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe(false)
  })

  it('a trusted empty replica genuinely means no events today', async () => {
    publishSyncHealth(TRUSTED)
    const { result } = renderHook(() => useEventsToday())
    await watchArmed()
    act(() => watch.emit([]))
    const today = localToday()
    await act(async () => fetchCalls[0].ok([restEvent('r1', `${today}T12:00:00Z`)]))
    expect(result.current.events).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})
