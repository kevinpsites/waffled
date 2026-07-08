// Meals ↔ calendar bridge. A planned meal_plan_entry gets a companion `events`
// row (origin='meal_plan', origin_ref_id=entry.id; entry.event_id reverse-links)
// so meals show on the calendar and — when the household opts in — push to the
// chosen person's Google write-target calendar (5.4). Behaviour is per-household
// settings (households.settings.meals): whether to add at all, whether to push to
// Google, whose calendar, who's invited, and the time each meal type lands at.
import { getPool, query } from '../../platform/db'
import { resolveWriteTarget, pushEventNow } from '../calendar/calendar-sync.service'
import { softDeleteEvent } from '../events/events'
import type { Tenant } from '../households/households'

const MEAL_LABEL: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }
const DEFAULT_TIMES: Record<string, string> = { breakfast: '08:00', lunch: '12:00', dinner: '18:00', snack: '15:00' }
// Thaw/prep reminder defaults — a morning-of nudge to pull ingredients (protein)
// out of the freezer for the meal scheduled that day. Off by default; dinner-only.
const PREP_DEFAULT_TIME = '08:00'
const PREP_DEFAULT_MEAL_TYPES = ['dinner']
const PREP_DURATION_MINUTES = 15

export interface MealCalendarSettings {
  // Create a calendar event for each planned meal at all (shows on the Waffled
  // calendar). Off ⇒ meals never touch the calendar.
  addToCalendar: boolean
  // Also push those events to Google (the calendar person's write target). Off ⇒
  // the events stay inside Waffled.
  pushToGoogle: boolean
  // Whose calendar the meal events belong to (color/owner + Google write target).
  // Defaults to the household owner.
  calendarPersonId: string | null
  // Who's invited. null ⇒ the whole family (resolved at write time).
  participantIds: string[] | null
  times: Record<string, string> // meal_type → 'HH:MM' local
  durationMinutes: number
  // Create a same-day "thaw / get it out of the freezer" reminder event for
  // planned meals, so you remember to pull the protein/ingredients in the
  // morning. Independent of addToCalendar (you can have reminders without
  // meals on the calendar). Reuses the calendar person / Google-push / invitee
  // settings above.
  prepReminder: boolean
  prepReminderTime: string // local 'HH:MM' the reminder lands, on the meal's own date
  prepReminderMealTypes: string[] // which meal slots get a reminder (default just dinner)
}

// Read the resolved settings, filling defaults from the household (owner →
// calendar person; null participants ⇒ whole family is applied at write time).
export async function getMealSettings(householdId: string): Promise<MealCalendarSettings> {
  const { rows } = await query<{ settings: { meals?: Partial<MealCalendarSettings> } | null; owner_person_id: string | null }>(
    `select settings, owner_person_id from households where id = $1`,
    [householdId]
  )
  const m = rows[0]?.settings?.meals ?? {}
  return {
    addToCalendar: m.addToCalendar ?? true,
    pushToGoogle: m.pushToGoogle ?? true,
    calendarPersonId: m.calendarPersonId ?? rows[0]?.owner_person_id ?? null,
    participantIds: m.participantIds ?? null,
    times: { ...DEFAULT_TIMES, ...(m.times ?? {}) },
    durationMinutes: m.durationMinutes ?? 60,
    prepReminder: m.prepReminder ?? false,
    prepReminderTime: m.prepReminderTime ?? PREP_DEFAULT_TIME,
    prepReminderMealTypes: m.prepReminderMealTypes ?? PREP_DEFAULT_MEAL_TYPES,
  }
}

// Merge a patch into households.settings.meals (other settings keys preserved).
export async function setMealSettings(householdId: string, patch: Partial<MealCalendarSettings>): Promise<MealCalendarSettings> {
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('meals', coalesce(settings->'meals', '{}'::jsonb) || $2::jsonb)
      where id = $1`,
    [householdId, JSON.stringify(patch)]
  )
  return getMealSettings(householdId)
}

interface EntryEventRow {
  id: string
  date: string
  meal_type: string
  recipe_id: string | null
  title: string | null
  event_id: string | null
  recipe_title: string | null
  recipe_emoji: string | null
}

// Create or update the companion calendar event for one planned meal, applying
// current settings. If meals-on-calendar is off, removes any existing event.
export async function syncMealEventForEntry(tenant: Tenant, entryId: string): Promise<void> {
  const { rows } = await query<EntryEventRow>(
    `select mpe.id, to_char(mpe.date,'YYYY-MM-DD') as date, mpe.meal_type, mpe.recipe_id, mpe.title, mpe.event_id,
            r.title as recipe_title, r.emoji as recipe_emoji
       from meal_plan_entries mpe
       left join recipes r on r.id = mpe.recipe_id and r.deleted_at is null
      where mpe.household_id = $1 and mpe.id = $2 and mpe.deleted_at is null`,
    [tenant.householdId, entryId]
  )
  const e = rows[0]
  if (!e) return

  const settings = await getMealSettings(tenant.householdId)
  if (!settings.addToCalendar) {
    if (e.event_id) await removeMealEventForEntry(tenant.householdId, entryId)
    return
  }

  // Prefix with the meal type so a glance at the calendar says it's a planned
  // meal: "🍗 Dinner · Banh Mi-Style Chicken Bowls".
  const label = MEAL_LABEL[e.meal_type] || 'Meal'
  const dishName = e.title || e.recipe_title
  const emoji = e.recipe_emoji ? `${e.recipe_emoji} ` : ''
  const title = dishName ? `${emoji}${label} · ${dishName}` : label
  const time = settings.times[e.meal_type] || DEFAULT_TIMES[e.meal_type] || '12:00'

  const tzRow = await query<{ timezone: string }>(`select timezone from households where id = $1`, [tenant.householdId])
  const tz = tzRow.rows[0]?.timezone || 'UTC'

  // Route to Google only when opted in AND the calendar person has a writable
  // target; otherwise the event is Waffled-only (local_only).
  const target = settings.pushToGoogle ? await resolveWriteTarget(tenant.householdId, settings.calendarPersonId) : null
  const calendarId = target?.calendarId ?? null

  let participantIds = settings.participantIds
  if (!participantIds) {
    const ps = await query<{ id: string }>(`select id from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`, [tenant.householdId])
    participantIds = ps.rows.map((r) => r.id)
  }

  const client = await getPool().connect()
  try {
    await client.query('begin')
    let eventId = e.event_id
    if (eventId) {
      const upd = await client.query<{ id: string }>(
        `update events set
            title = $3,
            starts_at = (($4::date + $5::time) at time zone $6),
            ends_at = (($4::date + $5::time) at time zone $6) + ($7 || ' minutes')::interval,
            all_day = false, timezone = $6, person_id = $8, calendar_id = $9::uuid,
            origin = 'meal_plan', origin_ref_id = $2, deleted_at = null,
            sync_state = case when $9::uuid is not null then 'pending_push' else 'local_only' end,
            updated_at = now()
          where household_id = $1 and id = $10
          returning id`,
        [tenant.householdId, entryId, title, e.date, time, tz, settings.durationMinutes, settings.calendarPersonId, calendarId, eventId]
      )
      if (!upd.rows[0]) eventId = null // event vanished — fall through and recreate
    }
    if (!eventId) {
      const ins = await client.query<{ id: string }>(
        `insert into events
           (household_id, calendar_id, title, starts_at, ends_at, all_day, timezone, person_id, origin, origin_ref_id, sync_state)
         values ($1, $9::uuid, $3,
                 (($4::date + $5::time) at time zone $6),
                 (($4::date + $5::time) at time zone $6) + ($7 || ' minutes')::interval,
                 false, $6, $8, 'meal_plan', $2,
                 case when $9::uuid is not null then 'pending_push' else 'local_only' end)
         returning id`,
        [tenant.householdId, entryId, title, e.date, time, tz, settings.durationMinutes, settings.calendarPersonId, calendarId]
      )
      eventId = ins.rows[0].id
      await client.query(`update meal_plan_entries set event_id = $1 where id = $2 and household_id = $3`, [eventId, entryId, tenant.householdId])
    }
    await client.query(`delete from event_participants where event_id = $1`, [eventId])
    for (const pid of [...new Set(participantIds)]) {
      await client.query(`insert into event_participants (household_id, event_id, person_id) values ($1,$2,$3)`, [tenant.householdId, eventId, pid])
    }
    await client.query('commit')
    // Push outside the transaction; a failure is recorded as push_failed and
    // retried on the next sync — never fails the meal-plan write.
    if (calendarId) await pushEventNow(tenant.householdId, eventId).catch(() => {})
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Drop the companion event for a meal (soft-delete + mirror the Google delete).
export async function removeMealEventForEntry(householdId: string, entryId: string): Promise<void> {
  const { rows } = await query<{ event_id: string | null }>(
    `select event_id from meal_plan_entries where household_id = $1 and id = $2`,
    [householdId, entryId]
  )
  const eventId = rows[0]?.event_id
  if (!eventId) return
  await softDeleteEvent(householdId, eventId)
  await query(`update meal_plan_entries set event_id = null where id = $1 and household_id = $2`, [entryId, householdId])
}

// Create or update the same-day thaw/prep reminder for one planned meal. Unlike
// the meal event this is a *second* derived event per entry, so it isn't stored
// on meal_plan_entries.event_id — it's found/managed purely via
// origin='meal_prep' + origin_ref_id=entry.id. If the reminder is off (globally
// or for this meal type) any existing one is removed.
export async function syncPrepReminderForEntry(tenant: Tenant, entryId: string): Promise<void> {
  const { rows } = await query<EntryEventRow>(
    `select mpe.id, to_char(mpe.date,'YYYY-MM-DD') as date, mpe.meal_type, mpe.recipe_id, mpe.title, mpe.event_id,
            r.title as recipe_title, r.emoji as recipe_emoji
       from meal_plan_entries mpe
       left join recipes r on r.id = mpe.recipe_id and r.deleted_at is null
      where mpe.household_id = $1 and mpe.id = $2 and mpe.deleted_at is null`,
    [tenant.householdId, entryId]
  )
  const e = rows[0]
  if (!e) return

  const existing = await query<{ id: string }>(
    `select id from events where household_id = $1 and origin = 'meal_prep' and origin_ref_id = $2 and deleted_at is null limit 1`,
    [tenant.householdId, entryId]
  )
  const existingId = existing.rows[0]?.id ?? null

  const settings = await getMealSettings(tenant.householdId)
  const dishName = e.title || e.recipe_title
  const enabled = settings.prepReminder && settings.prepReminderMealTypes.includes(e.meal_type) && !!dishName
  if (!enabled) {
    if (existingId) await softDeleteEvent(tenant.householdId, existingId)
    return
  }

  // "🧊 Thaw for Dinner · Garlic Chicken" — a glance says pull it from the freezer.
  const label = MEAL_LABEL[e.meal_type] || 'meal'
  const title = `🧊 Thaw for ${label} · ${dishName}`
  const time = settings.prepReminderTime || PREP_DEFAULT_TIME

  const tzRow = await query<{ timezone: string }>(`select timezone from households where id = $1`, [tenant.householdId])
  const tz = tzRow.rows[0]?.timezone || 'UTC'

  const target = settings.pushToGoogle ? await resolveWriteTarget(tenant.householdId, settings.calendarPersonId) : null
  const calendarId = target?.calendarId ?? null

  let participantIds = settings.participantIds
  if (!participantIds) {
    const ps = await query<{ id: string }>(`select id from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`, [tenant.householdId])
    participantIds = ps.rows.map((r) => r.id)
  }

  const client = await getPool().connect()
  try {
    await client.query('begin')
    let eventId: string | null = existingId
    if (eventId) {
      const upd = await client.query<{ id: string }>(
        `update events set
            title = $3,
            starts_at = (($4::date + $5::time) at time zone $6),
            ends_at = (($4::date + $5::time) at time zone $6) + ($7 || ' minutes')::interval,
            all_day = false, timezone = $6, person_id = $8, calendar_id = $9::uuid,
            origin = 'meal_prep', origin_ref_id = $2, deleted_at = null,
            sync_state = case when $9::uuid is not null then 'pending_push' else 'local_only' end,
            updated_at = now()
          where household_id = $1 and id = $10
          returning id`,
        [tenant.householdId, entryId, title, e.date, time, tz, PREP_DURATION_MINUTES, settings.calendarPersonId, calendarId, eventId]
      )
      if (!upd.rows[0]) eventId = null // event vanished — recreate
    }
    if (!eventId) {
      const ins = await client.query<{ id: string }>(
        `insert into events
           (household_id, calendar_id, title, starts_at, ends_at, all_day, timezone, person_id, origin, origin_ref_id, sync_state)
         values ($1, $9::uuid, $3,
                 (($4::date + $5::time) at time zone $6),
                 (($4::date + $5::time) at time zone $6) + ($7 || ' minutes')::interval,
                 false, $6, $8, 'meal_prep', $2,
                 case when $9::uuid is not null then 'pending_push' else 'local_only' end)
         returning id`,
        [tenant.householdId, entryId, title, e.date, time, tz, PREP_DURATION_MINUTES, settings.calendarPersonId, calendarId]
      )
      eventId = ins.rows[0].id
    }
    await client.query(`delete from event_participants where event_id = $1`, [eventId])
    for (const pid of [...new Set(participantIds)]) {
      await client.query(`insert into event_participants (household_id, event_id, person_id) values ($1,$2,$3)`, [tenant.householdId, eventId, pid])
    }
    await client.query('commit')
    if (calendarId) await pushEventNow(tenant.householdId, eventId).catch(() => {})
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Drop the thaw/prep reminder for a meal (soft-delete + mirror the Google delete).
export async function removePrepReminderForEntry(householdId: string, entryId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `select id from events where household_id = $1 and origin = 'meal_prep' and origin_ref_id = $2 and deleted_at is null`,
    [householdId, entryId]
  )
  for (const r of rows) await softDeleteEvent(householdId, r.id)
}

// Reconcile every active meal with current settings — used after a settings
// change so toggles / new times / a different calendar person apply retroactively.
export async function resyncMealEvents(tenant: Tenant): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `select id from meal_plan_entries where household_id = $1 and deleted_at is null`,
    [tenant.householdId]
  )
  for (const r of rows) {
    await syncMealEventForEntry(tenant, r.id)
    await syncPrepReminderForEntry(tenant, r.id)
  }
  return rows.length
}
