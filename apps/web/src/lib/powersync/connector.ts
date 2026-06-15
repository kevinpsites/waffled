// PowerSync connector. The kiosk is a read-only consumer here: it downloads its
// household's rows and never uploads (writes go through the REST API, which owns
// the Google sync). fetchCredentials exchanges the kiosk session for a short-lived
// PowerSync token from our api (the same /api/powersync/token used everywhere).
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web'
import { apiGet } from '../api/client'

export class NookConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const { token, powerSyncUrl } = await apiGet<{ token: string; powerSyncUrl: string | null }>(
      '/api/powersync/token'
    )
    if (!token || !powerSyncUrl) return null
    return { endpoint: powerSyncUrl, token }
  }

  // Read-only client: nothing to upload. (Writes happen via REST, which pushes to
  // Google and lets the change replicate back down through PowerSync.)
  async uploadData(_database: AbstractPowerSyncDatabase): Promise<void> {
    /* no-op */
  }
}
