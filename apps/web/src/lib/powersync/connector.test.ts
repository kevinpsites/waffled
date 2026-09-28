import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AbstractPowerSyncDatabase } from '@powersync/web'

const clientMocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiGet: clientMocks.apiGet,
  apiSend: clientMocks.apiSend,
}))

import { ApiSendError } from '../api/client'
import { WaffledConnector } from './connector'

function databaseWithOneTransaction(complete: ReturnType<typeof vi.fn>): AbstractPowerSyncDatabase {
  const transaction = {
    crud: [{ op: 'PUT', table: 'events', id: 'event-1', opData: { title: 'Dinner' } }],
    complete,
  }
  return {
    getNextCrudTransaction: vi.fn()
      .mockResolvedValueOnce(transaction)
      .mockResolvedValueOnce(null),
  } as unknown as AbstractPowerSyncDatabase
}

describe('PowerSync upload rejection handling', () => {
  beforeEach(() => clientMocks.apiSend.mockReset())

  it.each([
    ['AuthError', 'Guest access is read-only'],
    ['Forbidden', 'Guest access is read-only.'],
  ])(
    'acknowledges a permanent guest rejection (%s) so it cannot block the queue',
    async (errorName, message) => {
      const complete = vi.fn().mockResolvedValue(undefined)
      clientMocks.apiSend.mockRejectedValueOnce(
        new ApiSendError('POST', '/api/powersync/crud', 403, { error: errorName, message })
      )

      await expect(new WaffledConnector().uploadData(databaseWithOneTransaction(complete))).resolves.toBeUndefined()
      expect(complete).toHaveBeenCalledOnce()
    }
  )

  it('keeps transient and unrelated failures queued for retry', async () => {
    const complete = vi.fn().mockResolvedValue(undefined)
    const error = new ApiSendError('POST', '/api/powersync/crud', 503, { error: 'Unavailable' })
    clientMocks.apiSend.mockRejectedValueOnce(error)

    await expect(new WaffledConnector().uploadData(databaseWithOneTransaction(complete))).rejects.toBe(error)
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not discard an unrelated forbidden response', async () => {
    const complete = vi.fn().mockResolvedValue(undefined)
    const error = new ApiSendError('POST', '/api/powersync/crud', 403, {
      error: 'Forbidden',
      message: 'Admin privileges required',
    })
    clientMocks.apiSend.mockRejectedValueOnce(error)

    await expect(new WaffledConnector().uploadData(databaseWithOneTransaction(complete))).rejects.toBe(error)
    expect(complete).not.toHaveBeenCalled()
  })
})
