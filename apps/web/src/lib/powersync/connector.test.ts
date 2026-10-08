import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiSendError } from '../api/client'

const apiSend = vi.hoisted(() => vi.fn())
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiSend,
}))

import { WaffledConnector } from './connector'

type FakeTx = { crud: Array<{ op: string; table: string; id: string; opData?: Record<string, unknown> }>; complete: ReturnType<typeof vi.fn> }

function queue(...ids: string[]) {
  const txs: FakeTx[] = ids.map((id) => ({
    crud: [{ op: 'PATCH', table: 'events', id, opData: { title: id } }],
    complete: vi.fn(async () => {
      txs.splice(txs.indexOf(tx), 1)
    }),
  }))
  let tx: FakeTx
  const db = {
    getNextCrudTransaction: vi.fn(async () => {
      tx = txs[0]
      return tx ?? null
    }),
  }
  return { db, txs }
}

const rejected = (status: number) => new ApiSendError('POST', '/api/powersync/crud', status, { error: 'X' })

describe('WaffledConnector.uploadData', () => {
  beforeEach(() => {
    apiSend.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('drops a transaction the server permanently rejects and uploads the rest', async () => {
    const { db, txs } = queue('bad', 'good')
    apiSend.mockRejectedValueOnce(rejected(400)).mockResolvedValueOnce({ applied: 1 })

    await new WaffledConnector().uploadData(db as never)

    expect(apiSend).toHaveBeenCalledTimes(2)
    expect(apiSend.mock.calls[1][2]).toEqual({ ops: [{ op: 'PATCH', table: 'events', id: 'good', data: { title: 'good' } }] })
    expect(txs).toHaveLength(0)
  })

  it.each([403, 404, 409, 422])('treats %i as final', async (status) => {
    const { db, txs } = queue('bad')
    apiSend.mockRejectedValueOnce(rejected(status))

    await new WaffledConnector().uploadData(db as never)

    expect(txs).toHaveLength(0)
  })

  it.each([401, 408, 429, 500, 503])('keeps the queue and rethrows on a retryable %i', async (status) => {
    const { db, txs } = queue('a', 'b')
    apiSend.mockRejectedValueOnce(rejected(status))

    await expect(new WaffledConnector().uploadData(db as never)).rejects.toBeInstanceOf(ApiSendError)

    expect(txs).toHaveLength(2)
    expect(apiSend).toHaveBeenCalledTimes(1)
  })

  it('keeps the queue when the request never got an answer', async () => {
    const { db, txs } = queue('a')
    apiSend.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(new WaffledConnector().uploadData(db as never)).rejects.toThrow('Failed to fetch')

    expect(txs).toHaveLength(1)
  })
})
