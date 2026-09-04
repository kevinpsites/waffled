// PowerSync connector. The kiosk is a read-only consumer here: it downloads its
// household's rows and never uploads (writes go through the REST API, which owns
// the Google sync). fetchCredentials exchanges the kiosk session for a short-lived
// PowerSync token from our api (the same /api/powersync/token used everywhere).
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web'
import { ApiSendError, apiGet, apiSend, currentIdentityScope } from '../api/client'
import { withPrincipalUseLock } from './principal-transition'

function isGuestReadOnlyRejection(error: unknown): boolean {
  if (!(error instanceof ApiSendError) || error.status !== 403) return false
  const message = error.body.message
  return message === 'Guest access is read-only' || message === 'Guest access is read-only.'
}

export class WaffledConnector implements PowerSyncBackendConnector {
  private readonly identityScope = currentIdentityScope()

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    if (currentIdentityScope() !== this.identityScope) return null
    const { token, powerSyncUrl } = await apiGet<{ token: string; powerSyncUrl: string | null }>(
      '/api/powersync/token'
    )
    if (currentIdentityScope() !== this.identityScope) return null
    if (!token || !powerSyncUrl) return null
    return { endpoint: powerSyncUrl, token }
  }

  // Drain queued local writes to the server's CRUD sink (offline writes). Each
  // transaction's row ops are forwarded as-is; the server applies them keyed on the
  // client id and pushes events to Google. Transient failures are thrown so
  // PowerSync retries (the queue persists across offline/reload). A guest rejection
  // is permanent for that optimistic write: acknowledge it so the queue can advance;
  // the next down-sync restores the server-authoritative row.
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    await withPrincipalUseLock(async () => {
      if (currentIdentityScope() !== this.identityScope) {
        throw new Error('Principal changed before PowerSync upload')
      }
      for (let tx = await database.getNextCrudTransaction(); tx; tx = await database.getNextCrudTransaction()) {
        if (currentIdentityScope() !== this.identityScope) {
          throw new Error('Principal changed during PowerSync upload')
        }
        const ops = tx.crud.map((e) => ({ op: e.op, table: e.table, id: e.id, data: e.opData }))
        try {
          await apiSend('POST', '/api/powersync/crud', { ops })
        } catch (error) {
          if (!isGuestReadOnlyRejection(error)) throw error
        }
        if (currentIdentityScope() !== this.identityScope) {
          throw new Error('Principal changed before PowerSync acknowledged an upload')
        }
        await tx.complete()
      }
    })
  }
}
