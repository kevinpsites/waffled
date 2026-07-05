// Series-level goal links for GOOGLE-sourced recurring events. Google sync expands
// recurrences (singleEvents=true) into one events row per instance, all sharing one
// ical_uid. A goal link is Waffled-owned and preserved across sync, but a NEW instance
// streaming in later carries no link — so linking "the series" would only stick on the
// instances that existed at link time. event_series_meta (keyed by household + ical_uid)
// is the durable record of that choice: linking writes it here AND fans the goal out to
// every current instance; sync reads it back so a fresh instance inherits the goal.
//
// Waffled-native events (single events / Waffled-owned recurring masters) have no ical_uid —
// for them there's no series fan-out, so callers fall back to today's per-event behavior.
import type { PoolClient } from 'pg'
import { getPool, query } from '../../platform/db'

// Upsert the series meta row for (household, ical_uid) and fan the goal link out to
// EVERY current non-deleted events row sharing that ical_uid. Called when a goal is
// linked to one instance of a Google series so the whole series picks it up and future
// instances inherit it (via applySeriesMeta on sync). Idempotent.
export async function upsertSeriesMeta(
  householdId: string,
  icalUid: string,
  goalId: string | null,
  goalStepId: string | null
): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    await client.query(
      `insert into event_series_meta (household_id, ical_uid, goal_id, goal_step_id)
       values ($1, $2, $3, $4)
       on conflict (household_id, ical_uid) where deleted_at is null
       do update set goal_id = excluded.goal_id, goal_step_id = excluded.goal_step_id`,
      [householdId, icalUid, goalId, goalStepId]
    )
    await client.query(
      `update events
          set goal_id = $3, goal_step_id = $4
        where household_id = $1 and ical_uid = $2 and deleted_at is null`,
      [householdId, icalUid, goalId, goalStepId]
    )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// On sync: a freshly-persisted Google instance with no explicit goal link inherits the
// series' goal from event_series_meta (if any). No-op when the series isn't tracked, or
// when the row already carries a link (an existing instance preserved its own across the
// upsert). `client` lets the sync transaction run this in the same connection.
export async function applySeriesMeta(
  client: PoolClient,
  householdId: string,
  icalUid: string | null
): Promise<void> {
  if (!icalUid) return
  await client.query(
    `update events e
        set goal_id = m.goal_id, goal_step_id = m.goal_step_id
       from event_series_meta m
      where m.household_id = $1 and m.ical_uid = $2 and m.deleted_at is null
        and e.household_id = $1 and e.ical_uid = $2 and e.deleted_at is null
        and e.goal_id is null`,
    [householdId, icalUid]
  )
}

// Read the live series meta row for a (household, ical_uid), if any (helper for tests
// and callers that want to know whether a series is goal-tracked).
export async function getSeriesMeta(
  householdId: string,
  icalUid: string
): Promise<{ goalId: string | null; goalStepId: string | null } | null> {
  const { rows } = await query<{ goal_id: string | null; goal_step_id: string | null }>(
    `select goal_id, goal_step_id from event_series_meta
      where household_id = $1 and ical_uid = $2 and deleted_at is null`,
    [householdId, icalUid]
  )
  const r = rows[0]
  return r ? { goalId: r.goal_id, goalStepId: r.goal_step_id } : null
}
