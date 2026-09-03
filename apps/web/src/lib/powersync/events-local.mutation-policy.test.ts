import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it.each([null, 'guest', 'house-sitter'])('does not touch SQLite for role %s', async (role) => {
    setCurrentViewerMemberType(role)

    await expect(createEventLocal(draft)).resolves.toBe(false)
    await expect(updateEventLocal('event-1', draft)).resolves.toBe(false)
    await expect(deleteEventLocal('event-1')).resolves.toBe(false)

    expect(dbMocks.getPowerSyncDb).not.toHaveBeenCalled()
  })

  it('continues to the local database for a known write-capable role', async () => {
    setCurrentViewerMemberType('adult')
    dbMocks.getPowerSyncDb.mockReturnValue(null)

    await expect(createEventLocal(draft)).resolves.toBe(false)
    expect(dbMocks.getPowerSyncDb).toHaveBeenCalledOnce()
  })
})
