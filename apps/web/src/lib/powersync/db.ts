// PowerSync client lifecycle. Lazily created and connected at app boot (real
// browser only) so the test/jsdom environment never loads the SQLite WASM. Every
// step is best-effort: if PowerSync can't init/connect, the kiosk simply keeps
// reading over REST (just without the live auto-refresh). onTablesChange lets the
// data hooks refetch the instant replicated rows change.
import { PowerSyncDatabase } from '@powersync/web'
import { AppSchema } from './schema'
import { WaffledConnector } from './connector'

let db: PowerSyncDatabase | null = null

export function getPowerSyncDb(): PowerSyncDatabase | null {
  return db
}

// Stand up the local DB and start streaming this household's rows. Safe to call
// more than once; only the first call does work. Never throws.
export async function connectPowerSync(): Promise<void> {
  if (db) return
  try {
    const instance = new PowerSyncDatabase({
      schema: AppSchema,
      database: { dbFilename: 'waffled.db' },
    })
    await instance.init()
    db = instance
    // connect() retries internally; fetchCredentials returning null just means
    // "not signed in yet" — it'll connect once a token is available.
    await instance.connect(new WaffledConnector())
  } catch (err) {
    console.warn('PowerSync unavailable; falling back to REST only', err)
    db = null
  }
}

// Subscribe to changes on the given tables; returns a disposer. A no-op (with a
// no-op disposer) when PowerSync isn't running, so callers need no guards.
export function onTablesChange(tables: string[], cb: () => void): () => void {
  if (!db) return () => {}
  try {
    return db.onChange(
      {
        onChange: () => {
          cb()
        },
      },
      { tables }
    )
  } catch {
    return () => {}
  }
}
