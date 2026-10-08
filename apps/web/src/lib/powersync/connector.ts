// PowerSync connector. The kiosk is a read-only consumer here: it downloads its
// household's rows and never uploads (writes go through the REST API, which owns
// the Google sync). fetchCredentials exchanges the kiosk session for a short-lived
// PowerSync token from our api (the same /api/powersync/token used everywhere).
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web'
import { ApiSendError, apiGet, apiSend } from '../api/client'

// A 4xx is the server's final word on a transaction, except an expired session, a
// timeout or throttling — and only when the api itself answered: every api error
// carries a JSON `error` code, a proxy's HTML 404 does not. Same rule as iOS
// `UploadQueue.isPermanentRejection` and the Android `WaffledConnector`.
const RETRYABLE_4XX = new Set([401, 408, 429])
export function isPermanentRejection(err: unknown): boolean {
  return (
    err instanceof ApiSendError &&
    err.status >= 400 &&
    err.status < 500 &&
    !RETRYABLE_4XX.has(err.status) &&
    typeof err.body?.error === 'string'
  )
}

export class WaffledConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const { token, powerSyncUrl } = await apiGet<{ token: string; powerSyncUrl: string | null }>(
      '/api/powersync/token'
    )
    if (!token || !powerSyncUrl) return null
    return { endpoint: powerSyncUrl, token }
  }

  // Drain queued local writes to the server's CRUD sink (offline writes). Each
  // transaction's row ops are forwarded as-is; the server applies them keyed on the
  // client id and pushes events to Google. On failure we throw so PowerSync retries
  // (the queue persists, so writes survive offline/reload) — except a permanent
  // rejection, which would otherwise wedge every write queued behind it.
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    for (let tx = await database.getNextCrudTransaction(); tx; tx = await database.getNextCrudTransaction()) {
      const ops = tx.crud.map((e) => ({ op: e.op, table: e.table, id: e.id, data: e.opData }))
      try {
        await apiSend('POST', '/api/powersync/crud', { ops })
      } catch (err) {
        if (!isPermanentRejection(err)) throw err
        console.warn('PowerSync upload rejected by the server; dropping it', err, ops)
      }
      await tx.complete()
    }
  }
}
