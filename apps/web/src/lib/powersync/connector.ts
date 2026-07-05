// PowerSync connector. The kiosk is a read-only consumer here: it downloads its
// household's rows and never uploads (writes go through the REST API, which owns
// the Google sync). fetchCredentials exchanges the kiosk session for a short-lived
// PowerSync token from our api (the same /api/powersync/token used everywhere).
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web'
import { apiGet, apiSend } from '../api/client'

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
  // (the queue persists, so writes survive offline/reload).
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    for (let tx = await database.getNextCrudTransaction(); tx; tx = await database.getNextCrudTransaction()) {
      const ops = tx.crud.map((e) => ({ op: e.op, table: e.table, id: e.id, data: e.opData }))
      await apiSend('POST', '/api/powersync/crud', { ops })
      await tx.complete()
    }
  }
}
