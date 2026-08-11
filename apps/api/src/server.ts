// Container entrypoint. On AWS this file is unused — lambda.ts is the handler.
import api from './app'
import { config } from './platform/config'
import { log } from './platform/logger'
import { createHttpServer } from './platform/http-server'
import { version } from './platform/version'
import { startSyncScheduler } from './modules/calendar/calendar-sync.service'
import { startExpansionScheduler } from './modules/calendar/expansion.service'
import { startIcsSyncScheduler } from './modules/calendar/ics-feeds'
import { startProofCleanupScheduler } from './modules/chores/chore-proof-cleanup.service'
import { startRecipeIngestCleanupScheduler } from './modules/meals/recipe-ingest.service'

const server = createHttpServer(api)

server.listen(config.port, () => {
  log.info('waffled-api listening', { port: config.port, authMode: config.auth.mode, sha: version.sha })
  // Background poll: pull connected-calendar changes (Google + Outlook) into
  // Waffled on an interval so edits/deletes made provider-side appear without a
  // manual sync.
  startSyncScheduler()
  // Poll subscribed ICS feed URLs (school calendars etc.) — no OAuth needed.
  startIcsSyncScheduler()
  // Roll the recurring-event occurrence horizon forward (Google-independent).
  startExpansionScheduler()
  // Delete chore photo-proof blobs past their per-household retention window.
  startProofCleanupScheduler()
  // Delete AI recipe-ingest source photos past their (short) retention window.
  startRecipeIngestCleanupScheduler()
})
