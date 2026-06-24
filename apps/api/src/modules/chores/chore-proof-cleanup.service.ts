// Chore photo-proof retention. Proof photos are throwaway verification, not
// memories, so a background sweep deletes the blob N days after a chore is settled
// (status 'done'). The window is per-household (settings.chores.proofTtlDays,
// default 3; 0 or negative = keep indefinitely). The `had_proof` flag is left set
// so the UI can still say "approved with a photo (no longer available)".
//
// Reject/uncomplete already delete a proof immediately — this only handles the
// settled-then-aged case. Awaiting proofs are never swept (a parent must still be
// able to review them, however old).
import { query } from '../../platform/db'
import { getBlobStore } from '../../platform/storage'

export const DEFAULT_PROOF_TTL_DAYS = 3

// Read a household's proof-retention window (days), defaulting to 3 when unset.
export async function getProofTtlDays(householdId: string): Promise<number> {
  const { rows } = await query<{ v: number | null }>(
    `select (settings #>> '{chores,proofTtlDays}')::int as v from households where id = $1`,
    [householdId]
  )
  const v = rows[0]?.v
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_PROOF_TTL_DAYS
}

// Persist a household's proof-retention window. Clamped to a sane range; 0 means
// "keep indefinitely".
export async function setProofTtlDays(householdId: string, days: number): Promise<number> {
  const clamped = Math.max(0, Math.min(365, Math.round(days)))
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('chores',
                            coalesce(settings->'chores', '{}'::jsonb)
                            || jsonb_build_object('proofTtlDays', $2::int))
      where id = $1`,
    [householdId, clamped]
  )
  return clamped
}

// One sweep across every household: for settled ('done') instances whose proof is
// older than that household's TTL, delete the blob and null the key/content-type
// (keeping had_proof). Returns counts for logging/tests.
export async function cleanupExpiredProofs(): Promise<{ deletedBlobs: number; households: number }> {
  const { rows: households } = await query<{ id: string; ttl: number }>(
    `select id, coalesce((settings #>> '{chores,proofTtlDays}')::int, ${DEFAULT_PROOF_TTL_DAYS}) as ttl
       from households where deleted_at is null`
  )
  const store = getBlobStore()
  let deletedBlobs = 0
  for (const h of households) {
    if (!Number.isFinite(h.ttl) || h.ttl <= 0) continue // keep indefinitely
    // Atomically null the columns and hand back the keys we need to delete.
    const { rows } = await query<{ proof_storage_key: string }>(
      `with expired as (
         select id, proof_storage_key from chore_instances
          where household_id = $1 and status = 'done' and proof_storage_key is not null
            and completed_at < now() - make_interval(days => $2::int)
          for update
       ), upd as (
         update chore_instances ci
            set proof_storage_key = null, proof_content_type = null
           from expired e where ci.id = e.id
       )
       select proof_storage_key from expired`,
      [h.id, h.ttl]
    )
    for (const r of rows) {
      try {
        await store.delete(r.proof_storage_key)
        deletedBlobs++
      } catch (err) {
        console.error('chore proof sweep: blob delete failed', r.proof_storage_key, err)
      }
    }
  }
  return { deletedBlobs, households: households.length }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null

// Periodic proof sweep (default once a day). Mirrors the calendar sync / expansion
// schedulers in server.ts. Container-only — Lambda never runs server.ts.
export function startProofCleanupScheduler(): void {
  if (cleanupTimer) return
  const intervalMs = parseInt(process.env.CHORE_PROOF_CLEANUP_INTERVAL_MS ?? '86400000', 10)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  let running = false
  cleanupTimer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await cleanupExpiredProofs()
    } catch (err) {
      console.error('chore proof cleanup tick error', err)
    } finally {
      running = false
    }
  }, intervalMs)
  cleanupTimer.unref?.()
  console.log(`chore proof cleanup scheduler started (every ${Math.round(intervalMs / 1000)}s)`)
}
