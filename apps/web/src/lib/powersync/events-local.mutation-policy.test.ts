import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({ getPowerSyncDb: vi.fn() }))
vi.mock('./db', () => ({
  getPowerSyncDb: dbMocks.getPowerSyncDb,
  onPowerSyncRecreated: vi.fn(() => () => {}),
}))

import { setCurrentViewerMemberType } from '../api/client'
import { createEventLocal, deleteEventLocal, updateEventLocal, type EventDraft } from './events-local'

const draft: EventDraft = {
  title: 'Dinner',
  startsAt: '2026-09-03T18:00:00Z',
  endsAt: null,
  allDay: false,
  location: null,
  personIds: [],
}

describe('local PowerSync mutation policy', () => {
  beforeEach(() => {
    dbMocks.getPowerSyncDb.mockReset()
    setCurrentViewerMemberType(null)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([null, 'guest', 'house-sitter'])('does not touch SQLite for role %s', async (role) => {
    setCurrentViewerMemberType(role)

    await expect(createEventLocal(draft)).resolves.toBe('rest-fallback')
    await expect(updateEventLocal('event-1', draft)).resolves.toBe('rest-fallback')
    await expect(deleteEventLocal('event-1')).resolves.toBe('rest-fallback')

    expect(dbMocks.getPowerSyncDb).not.toHaveBeenCalled()
  })

  it('continues to the local database for a known write-capable role', async () => {
    setCurrentViewerMemberType('adult')
    dbMocks.getPowerSyncDb.mockReturnValue(null)

    await expect(createEventLocal(draft)).resolves.toBe('rest-fallback')
    expect(dbMocks.getPowerSyncDb).toHaveBeenCalledOnce()
  })

  it.each([
    ['create', () => createEventLocal(draft)],
    ['update', () => updateEventLocal('event-1', draft)],
    ['delete', () => deleteEventLocal('event-1')],
  ])('aborts a queued %s from A after an A -> B transition instead of permitting REST fallback', async (_kind, mutate) => {
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'principal-a',
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      memberType: 'adult',
      accessExpiresAt: null,
    }))
    setCurrentViewerMemberType('adult')

    let releaseTransition!: () => void
    const transitionFinished = new Promise<void>((resolve) => { releaseTransition = resolve })
    let writerQueued!: () => void
    const queued = new Promise<void>((resolve) => { writerQueued = resolve })
    const request = vi.fn(async <T>(
      _name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => T | PromiseLike<T>
    ): Promise<T> => {
      if (options.mode === 'shared') {
        writerQueued()
        await transitionFinished
      }
      return callback({ name: 'waffled:principal-replica', mode: options.mode ?? 'exclusive' } as Lock)
    })
    vi.stubGlobal('navigator', { onLine: true, locks: { request } })

    const writer = mutate()
    await queued
    localStorage.setItem('waffled.session.v1', JSON.stringify({
      v: 1,
      scope: 'principal-b',
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      memberType: 'adult',
      accessExpiresAt: null,
    }))
    releaseTransition()

    await expect(writer).resolves.toBe('aborted')
    expect(dbMocks.getPowerSyncDb).not.toHaveBeenCalled()
  })
})
