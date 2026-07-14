// Chores domain — data access + business logic. Routes live in chores.routes.ts.
// MVP: daily-recurring chores assigned to a person; today's instances are
// materialized on demand; completion awards stars via the ledger.
import type { QueryResultRow, PoolClient } from 'pg'
import { getPool, query } from '../../platform/db'
import { type Tenant } from '../households/households'
import { getDefaultCurrencyKey } from '../currencies/currencies'
import { getBlobStore, mediaUrl } from '../../platform/storage'
import type { ChoreRow, CreateChoreInput, PersonChoreSummary, TodayInstance } from './chores.types'

// Rewards sub-toggle (settings.chores.rewards) — the spend half of the chores
// economy. Defaults on; read/written from Settings → Chores & rewards.
export async function getChoreRewardsEnabled(householdId: string): Promise<boolean> {
  const { rows } = await query<{ v: boolean | null }>(
    `select (settings #>> '{chores,rewards}')::boolean as v from households where id = $1`,
    [householdId]
  )
  return rows[0]?.v ?? true
}

export async function setChoreRewardsEnabled(householdId: string, on: boolean): Promise<boolean> {
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('chores',
                            coalesce(settings->'chores', '{}'::jsonb)
                            || jsonb_build_object('rewards', $2::boolean))
      where id = $1`,
    [householdId, on]
  )
  return on
}

interface ChoreInstanceRow extends QueryResultRow {
  id: string
  person_id: string | null
  status: string
  completed_at: Date | null
  reward_currency: string | null
  reward_amount: number | null
  awarded: boolean
  requires_approval: boolean
  requires_photo: boolean
  proof_storage_key: string | null
  proof_content_type: string | null
  had_proof: boolean
}

// Thrown by completeInstance when a photo-proof chore is completed without a proof
// image. The route maps it to a 422 so the kiosk can prompt for a photo.
export class ProofRequiredError extends Error {
  constructor() {
    super('a photo is required to complete this chore')
    this.name = 'ProofRequiredError'
  }
}

// A best-effort blob delete that never throws into the caller's transaction path.
function deleteBlob(key: string | null | undefined): void {
  if (!key) return
  getBlobStore()
    .delete(key)
    .catch(() => {})
}

// "Today" as a calendar day. With a timezone it's the household-local day (so
// chores don't roll over at UTC midnight — i.e. early in the evening); without
// one it falls back to UTC.
export function todayDate(tz?: string): string {
  if (!tz) return new Date().toISOString().slice(0, 10)
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

export async function householdTz(householdId: string): Promise<string> {
  const { rows } = await query<{ timezone: string }>(`select timezone from households where id = $1`, [householdId])
  return rows[0]?.timezone ?? 'UTC'
}

// The day the Tasks view is asking for: a valid ?date= within ±31 days of `today`,
// else today. Bounds keep on-demand materialization of future instances cheap.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
export function requestedDate(raw: unknown, today: string): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) return today
  const diff = Math.round((Date.parse(`${raw}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)
  if (Number.isNaN(diff) || diff < -31 || diff > 31) return today
  return raw
}

export async function createChore(tenant: Tenant, input: CreateChoreInput): Promise<ChoreRow> {
  const currency = input.rewardCurrency?.trim() || (await getDefaultCurrencyKey(tenant.householdId))
  // A blank/absent rrule now persists as NULL — a true one-off — instead of being
  // coerced to FREQ=DAILY. One-offs have no scheduled materialization path (that's
  // only for recurring chores), so we drop their single instance ourselves, below.
  const rrule = input.rrule?.trim() || null
  const { rows } = await query<ChoreRow>(
    `insert into chores
       (household_id, title, emoji, person_id, rrule, reward_currency, reward_amount, due_time, requires_approval, requires_photo, rollover)
     values ($1, $2, $3, $4, $5, $6, coalesce($7,0), $8, $9, $10, $11)
     returning *`,
    [
      tenant.householdId,
      input.title,
      input.emoji ?? null,
      input.personId ?? null,
      rrule,
      currency,
      input.rewardAmount ?? 0,
      input.dueTime ?? null,
      input.requiresApproval ?? false,
      input.requiresPhoto ?? false,
      input.rollover ?? true,
    ]
  )
  const chore = rows[0]

  // One-off: materialize exactly ONE instance on the requested due date (default
  // household-local today). Snapshot columns mirror the recurring materialize
  // INSERT; the unique (chore_id, due_on) index guards a double-create.
  if (chore.rrule == null) {
    const dueOn = input.dueOn?.trim() || todayDate(await householdTz(tenant.householdId))
    await query(
      `insert into chore_instances
         (household_id, chore_id, person_id, due_on, reward_currency, reward_amount, requires_approval, requires_photo)
       select household_id, id, person_id, $2::date, reward_currency, reward_amount, requires_approval, requires_photo
         from chores where id = $1
       on conflict (chore_id, due_on) do nothing`,
      [chore.id, dueOn]
    )
  }
  return chore
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// Materialize today's instances (idempotent) for active chores due today: DAILY
// always, WEEKLY when today's weekday is in the rrule's BYDAY list. Day codes are
// all distinct 2-letter tokens, so a substring match within a WEEKLY BYDAY is safe.
export async function ensureTodayInstances(householdId: string, dueOn: string): Promise<void> {
  const dow = WEEKDAY_CODES[new Date(dueOn + 'T00:00:00').getDay()]
  await query(
    `insert into chore_instances
       (household_id, chore_id, person_id, due_on, reward_currency, reward_amount, requires_approval, requires_photo)
     select household_id, id, person_id, $2::date, reward_currency, reward_amount, requires_approval, requires_photo
       from chores
      where household_id = $1 and is_active and deleted_at is null and rrule is not null
        and (
          rrule ilike '%FREQ=DAILY%'
          or (rrule ilike '%FREQ=WEEKLY%' and rrule ~ ('BYDAY=[A-Z,]*' || $3))
        )
     on conflict (chore_id, due_on) do nothing`,
    [householdId, dueOn, dow]
  )
}

// Claim an up-for-grabs (unassigned) instance for a person — only if still
// unclaimed, so two kids can't grab the same one.
export async function claimInstance(tenant: Tenant, id: string, personId: string): Promise<ChoreInstanceRow | null> {
  const { rows } = await query<ChoreInstanceRow>(
    `update chore_instances set person_id=$3
       where household_id=$1 and id=$2 and person_id is null and deleted_at is null
       returning *`,
    [tenant.householdId, id, personId]
  )
  return rows[0] ?? null
}

// Move an instance to a different person, or back to up-for-grabs (personId null).
// Unlike claimInstance this doesn't require it to be currently unassigned — it's
// the board's drag-and-drop reassign. Leaves status/awarded untouched.
export async function setInstanceAssignee(
  tenant: Tenant,
  id: string,
  personId: string | null
): Promise<ChoreInstanceRow | null> {
  const { rows } = await query<ChoreInstanceRow>(
    `update chore_instances set person_id=$3
       where household_id=$1 and id=$2 and deleted_at is null
       returning *`,
    [tenant.householdId, id, personId]
  )
  return rows[0] ?? null
}

interface SummaryRow extends QueryResultRow {
  id: string
  name: string
  avatar_emoji: string | null
  color_hex: string | null
  member_type: string
  is_admin: boolean
  total: string
  done: string
  stars: string
}

// Per-person done/total for the day + balance in the household's default currency
// (drives the kiosk rings).
export async function todaySummary(householdId: string, dueOn: string, tz = 'UTC'): Promise<PersonChoreSummary[]> {
  const defaultCurrency = await getDefaultCurrencyKey(householdId)
  const { rows } = await query<SummaryRow>(
    `select p.id, p.name, p.avatar_emoji, p.color_hex, p.member_type, p.is_admin,
            count(c.id) as total,
            count(c.id) filter (where ci.status = 'done') as done,
            coalesce(b.balance, 0) as stars
       from persons p
       left join chore_instances ci
         on ci.person_id = p.id and ci.deleted_at is null
       left join chores c
         on c.id = ci.chore_id and c.deleted_at is null
         and (ci.due_on = $2::date
              or (ci.due_on < $2::date and ci.status = 'pending' and c.rrule is null and c.rollover)
              or (ci.due_on > $2::date and ci.status = 'pending' and c.rrule is null
                  and (ci.created_at at time zone $4)::date <= $2::date))
       left join v_person_balances b
         on b.person_id = p.id and b.currency = $3
      where p.household_id = $1 and p.deleted_at is null
      group by p.id, b.balance
      order by p.sort_order, p.created_at`,
    [householdId, dueOn, defaultCurrency, tz]
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    avatarEmoji: r.avatar_emoji,
    colorHex: r.color_hex,
    memberType: r.member_type,
    isAdmin: r.is_admin,
    total: Number(r.total),
    done: Number(r.done),
    stars: Number(r.stars),
  }))
}

// Unassigned pending instances that someone can claim from the Tasks board.
// Kept separate from the person summaries so API consumers never mistake this
// bucket for a household member.
export async function upForGrabsCount(householdId: string, dueOn: string, tz = 'UTC'): Promise<number> {
  const { rows } = await query<{ total: string }>(
    `select count(*) as total
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
      where ci.household_id = $1
        and ci.person_id is null
        and ci.status = 'pending'
        and ci.deleted_at is null
        and (ci.due_on = $2::date
             or (ci.due_on < $2::date and c.rrule is null and c.rollover)
             or (ci.due_on > $2::date and c.rrule is null
                 and (ci.created_at at time zone $3)::date <= $2::date))`,
    [householdId, dueOn, tz]
  )
  return Number(rows[0]?.total ?? 0)
}

// Per-chore streak: consecutive calendar days (ending today if done, else
// yesterday) the chore was completed. Day-based — exact for daily chores, an
// approximation for weekly ones. Computed in JS over the last ~60 days.
async function streaksByChore(householdId: string, dueOn: string): Promise<Map<string, number>> {
  const { rows } = await query<{ chore_id: string; due_on: string }>(
    `select chore_id, due_on::text from chore_instances
       where household_id=$1 and status='done' and deleted_at is null
         and due_on > ($2::date - 60) and due_on <= $2::date`,
    [householdId, dueOn]
  )
  const doneByChore = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!doneByChore.has(r.chore_id)) doneByChore.set(r.chore_id, new Set())
    doneByChore.get(r.chore_id)!.add(r.due_on.slice(0, 10))
  }
  const dayMs = 86_400_000
  const out = new Map<string, number>()
  for (const [choreId, days] of doneByChore) {
    // start at today if it's done, else yesterday, then walk back while done.
    let cursor = new Date(dueOn + 'T00:00:00')
    if (!days.has(dueOn)) cursor = new Date(cursor.getTime() - dayMs)
    let streak = 0
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak++
      cursor = new Date(cursor.getTime() - dayMs)
    }
    out.set(choreId, streak)
  }
  return out
}

export async function listTodayInstances(householdId: string, dueOn: string, tz = 'UTC'): Promise<TodayInstance[]> {
  const { rows } = await query<QueryResultRow>(
    `select ci.id, ci.status, ci.reward_amount, ci.reward_currency, ci.person_id, ci.requires_approval,
            ci.requires_photo, ci.proof_storage_key, ci.had_proof, ci.due_on::text as due_on,
            c.id as chore_id, c.title as chore_title, c.emoji, c.rrule, c.due_time::text as due_time,
            p.name as person_name, p.avatar_emoji, p.color_hex
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
       left join persons p on p.id = ci.person_id
      where ci.household_id = $1 and ci.deleted_at is null
        and (ci.due_on = $2::date
             or (ci.due_on < $2::date and ci.status = 'pending' and c.rrule is null and c.rollover)
             or (ci.due_on > $2::date and ci.status = 'pending' and c.rrule is null
                 and (ci.created_at at time zone $3)::date <= $2::date))
      order by p.sort_order nulls last, c.due_time nulls last, c.title`,
    [householdId, dueOn, tz]
  )
  const streaks = await streaksByChore(householdId, dueOn)
  return rows.map((r) => ({
    id: r.id,
    choreId: r.chore_id,
    choreTitle: r.chore_title,
    emoji: r.emoji,
    personId: r.person_id,
    personName: r.person_name,
    personAvatar: r.avatar_emoji,
    personColor: r.color_hex,
    dueOn: r.due_on,
    dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
    status: r.status,
    rewardAmount: r.reward_amount,
    rewardCurrency: r.reward_currency,
    rrule: r.rrule,
    requiresApproval: r.requires_approval,
    requiresPhoto: r.requires_photo,
    proofUrl: mediaUrl(r.proof_storage_key),
    hadProof: r.had_proof,
    streak: streaks.get(r.chore_id) ?? 0,
  }))
}

// All instances awaiting a parent's OK, across every date (the approvals queue).
// Same shape as listTodayInstances; streak isn't meaningful here so it's 0.
export async function listAwaitingInstances(householdId: string): Promise<TodayInstance[]> {
  const { rows } = await query<QueryResultRow>(
    `select ci.id, ci.status, ci.reward_amount, ci.reward_currency, ci.person_id, ci.requires_approval,
            ci.requires_photo, ci.proof_storage_key, ci.had_proof, ci.due_on::text as due_on,
            c.id as chore_id, c.title as chore_title, c.emoji, c.rrule, c.due_time::text as due_time,
            p.name as person_name, p.avatar_emoji, p.color_hex
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
       left join persons p on p.id = ci.person_id
      where ci.household_id = $1 and ci.status = 'awaiting' and ci.deleted_at is null
      order by ci.due_on desc, p.sort_order nulls last, c.title`,
    [householdId]
  )
  return rows.map((r) => ({
    id: r.id,
    choreId: r.chore_id,
    choreTitle: r.chore_title,
    emoji: r.emoji,
    personId: r.person_id,
    personName: r.person_name,
    personAvatar: r.avatar_emoji,
    personColor: r.color_hex,
    dueOn: r.due_on,
    dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
    status: r.status,
    rewardAmount: r.reward_amount,
    rewardCurrency: r.reward_currency,
    rrule: r.rrule,
    requiresApproval: r.requires_approval,
    requiresPhoto: r.requires_photo,
    proofUrl: mediaUrl(r.proof_storage_key),
    hadProof: r.had_proof,
    streak: 0,
  }))
}

export const UPDATABLE_CHORE: Record<string, string> = {
  title: 'title',
  emoji: 'emoji',
  personId: 'person_id',
  rewardAmount: 'reward_amount',
  rewardCurrency: 'reward_currency',
  dueTime: 'due_time',
  isActive: 'is_active',
  rrule: 'rrule',
  requiresApproval: 'requires_approval',
  requiresPhoto: 'requires_photo',
  rollover: 'rollover',
}

export async function updateChore(
  householdId: string,
  id: string,
  patch: Record<string, unknown>
): Promise<ChoreRow | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [field, column] of Object.entries(UPDATABLE_CHORE)) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${column} = $${i++}`)
      values.push(patch[field])
    }
  }
  values.push(householdId, id)
  const { rows } = await query<ChoreRow>(
    `update chores set ${sets.join(', ')}
       where household_id = $${i++} and id = $${i} and deleted_at is null
       returning *`,
    values
  )
  const updated = rows[0] ?? null

  // Reassigning the chore's "Who" should follow through to its not-yet-acted-on
  // instances from today forward, so editing the assignee (including back to
  // "up for grabs", person_id null) moves it on the board. Done/awaiting
  // instances keep whoever completed/submitted them, for stars-ledger integrity.
  if (updated && 'personId' in patch) {
    await query(
      `update chore_instances ci
          set person_id = $1
         from households h
        where ci.household_id = h.id
          and ci.household_id = $2
          and ci.chore_id = $3
          and ci.deleted_at is null
          and ci.status = 'pending'
          and ci.due_on >= (now() at time zone h.timezone)::date`,
      [(patch.personId as string | null) ?? null, householdId, id]
    )
  }

  // Reward + approval settings are copied onto each instance when it materializes, and
  // the instance's copy is what drives completion (requires_approval → awaiting) and
  // the editor's prefill. So a change to them must also flow to not-yet-acted-on
  // instances — otherwise toggling "Needs a parent's OK" leaves today's instance
  // unchanged and the edit looks lost (and wouldn't actually gate the next completion).
  // Done/awaiting instances are left alone, for stars-ledger integrity.
  if (updated) {
    const sets2: string[] = []
    const values2: unknown[] = []
    let j = 1
    for (const [field, column] of [
      ['requiresApproval', 'requires_approval'],
      ['requiresPhoto', 'requires_photo'],
      ['rewardAmount', 'reward_amount'],
      ['rewardCurrency', 'reward_currency'],
    ] as const) {
      if (field in patch && patch[field] !== undefined) {
        sets2.push(`${column} = $${j++}`)
        values2.push(patch[field])
      }
    }
    if (sets2.length) {
      values2.push(householdId, id)
      await query(
        `update chore_instances ci
            set ${sets2.join(', ')}
           from households h
          where ci.household_id = h.id
            and ci.household_id = $${j++}
            and ci.chore_id = $${j}
            and ci.deleted_at is null
            and ci.status = 'pending'
            and ci.due_on >= (now() at time zone h.timezone)::date`,
        values2
      )
    }
  }

  // A one-off's "On" day lives on its single pending instance, not the chore row — so an
  // edit that changes the due date must move that instance. Recurring chores (rrule set)
  // ignore dueOn. Done/awaiting instances are left alone (stars-ledger integrity).
  if (updated && updated.rrule === null && typeof patch.dueOn === 'string' && patch.dueOn.trim()) {
    await query(
      `update chore_instances
          set due_on = $1
        where household_id = $2 and chore_id = $3 and deleted_at is null and status = 'pending'`,
      [patch.dueOn.trim(), householdId, id]
    )
  }
  return updated
}

export async function softDeleteChore(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update chores set deleted_at = now() where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

export function presentInstance(i: ChoreInstanceRow) {
  return {
    id: i.id,
    personId: i.person_id,
    status: i.status,
    completedAt: i.completed_at,
    rewardAmount: i.reward_amount,
    awarded: i.awarded,
    requiresPhoto: i.requires_photo,
    proofUrl: mediaUrl(i.proof_storage_key),
    hadProof: i.had_proof,
  }
}

// Award a chore's stars once (one positive ledger entry + the awarded flag).
async function awardStars(client: PoolClient, tenant: Tenant, inst: ChoreInstanceRow, id: string): Promise<boolean> {
  if (inst.awarded || !inst.reward_amount || !inst.person_id) return false
  await client.query(
    `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
     values ($1,$2,$3,$4,'chore_completed','chore_instance',$5,$6)`,
    [tenant.householdId, inst.person_id, inst.reward_currency ?? 'stars', inst.reward_amount, id, tenant.personId]
  )
  await client.query(`update chore_instances set awarded=true where id=$1`, [id])
  return true
}

// Mark done + award stars. If the chore needs a parent's OK, park it in 'awaiting'
// (no stars yet — a parent approves later). If it needs a photo proof, a blob
// `key` must be supplied (or already stored) — otherwise ProofRequiredError.
// Idempotent.
export async function completeInstance(
  tenant: Tenant,
  id: string,
  proof?: { storageKey?: string | null; contentType?: string | null }
): Promise<ChoreInstanceRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<ChoreInstanceRow>(
      `select * from chore_instances where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const inst = cur.rows[0]
    if (!inst) {
      await client.query('rollback')
      return null
    }
    if (inst.status === 'done' || inst.status === 'awaiting') {
      await client.query('commit')
      return inst
    }
    const newKey = proof?.storageKey?.trim() || null
    if (inst.requires_photo && !newKey && !inst.proof_storage_key) {
      await client.query('rollback')
      throw new ProofRequiredError()
    }
    const nextStatus = inst.requires_approval ? 'awaiting' : 'done'
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances
          set status=$2, completed_by=$1, completed_at=now(),
              proof_storage_key=coalesce($4, proof_storage_key),
              proof_content_type=coalesce($5, proof_content_type),
              had_proof=(had_proof or $4 is not null)
        where id=$3 returning *`,
      [tenant.personId, nextStatus, id, newKey, proof?.contentType?.trim() || null]
    )
    const updated = upd.rows[0]
    if (nextStatus === 'done' && (await awardStars(client, tenant, updated, id))) updated.awarded = true
    await client.query('commit')
    return updated
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Parent approves an 'awaiting' instance → 'done' + award. Idempotent on 'done'.
export async function approveInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<ChoreInstanceRow>(
      `select * from chore_instances where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const inst = cur.rows[0]
    if (!inst) { await client.query('rollback'); return null }
    if (inst.status === 'done') { await client.query('commit'); return inst }
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances set status='done', completed_at=coalesce(completed_at, now()) where id=$1 returning *`,
      [id]
    )
    const updated = upd.rows[0]
    if (await awardStars(client, tenant, updated, id)) updated.awarded = true
    await client.query('commit')
    return updated
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Parent rejects an 'awaiting' instance → back to 'pending' for a redo. The proof
// photo (if any) is cleared and its blob deleted, so the redo starts fresh.
export async function rejectInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const prev = await query<{ proof_storage_key: string | null }>(
    `select proof_storage_key from chore_instances
       where household_id=$1 and id=$2 and status='awaiting' and deleted_at is null`,
    [tenant.householdId, id]
  )
  const { rows } = await query<ChoreInstanceRow>(
    `update chore_instances set status='pending', completed_by=null, completed_at=null,
         proof_storage_key=null, proof_content_type=null, had_proof=false
       where household_id=$1 and id=$2 and status='awaiting' and deleted_at is null
       returning *`,
    [tenant.householdId, id]
  )
  if (rows[0]) deleteBlob(prev.rows[0]?.proof_storage_key)
  return rows[0] ?? null
}

// Revert to pending; if stars were awarded, write a reversing ledger entry.
export async function uncompleteInstance(tenant: Tenant, id: string): Promise<ChoreInstanceRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const cur = await client.query<ChoreInstanceRow>(
      `select * from chore_instances where household_id=$1 and id=$2 and deleted_at is null for update`,
      [tenant.householdId, id]
    )
    const inst = cur.rows[0]
    if (!inst) {
      await client.query('rollback')
      return null
    }
    const upd = await client.query<ChoreInstanceRow>(
      `update chore_instances set status='pending', completed_by=null, completed_at=null,
           proof_storage_key=null, proof_content_type=null, had_proof=false where id=$1 returning *`,
      [id]
    )
    const updated = upd.rows[0]
    if (inst.proof_storage_key) deleteBlob(inst.proof_storage_key)
    if (inst.awarded && inst.reward_amount && inst.person_id) {
      await client.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
         values ($1,$2,$3,$4,'chore_uncompleted','chore_instance',$5,$6)`,
        [
          tenant.householdId,
          inst.person_id,
          inst.reward_currency ?? 'stars',
          -inst.reward_amount,
          id,
          tenant.personId,
        ]
      )
      await client.query(`update chore_instances set awarded=false where id=$1`, [id])
      updated.awarded = false
    }
    await client.query('commit')
    return updated
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export function presentChore(c: ChoreRow) {
  return {
    id: c.id,
    title: c.title,
    emoji: c.emoji,
    personId: c.person_id,
    rrule: c.rrule,
    rewardCurrency: c.reward_currency,
    rewardAmount: c.reward_amount,
    dueTime: c.due_time,
    isActive: c.is_active,
    requiresApproval: (c as { requires_approval?: boolean }).requires_approval ?? false,
    requiresPhoto: (c as { requires_photo?: boolean }).requires_photo ?? false,
    rollover: (c as { rollover?: boolean }).rollover ?? true,
  }
}

// ── Stored proof photos (Settings → review/manage) ───────────────────────────
// The currently-kept proof photos, so a parent can look back and delete them by
// hand (the home for the "keep until I delete them" retention option). Scoped to
// settled ('done') instances — awaiting proofs are managed via approve/reject.
export interface StoredProof {
  instanceId: string
  choreTitle: string
  emoji: string | null
  personName: string | null
  personAvatar: string | null
  personColor: string | null
  proofUrl: string | null
  completedAt: Date | null
}

export async function listStoredProofs(householdId: string): Promise<StoredProof[]> {
  const { rows } = await query<QueryResultRow>(
    `select ci.id, ci.proof_storage_key, ci.completed_at,
            c.title as chore_title, c.emoji,
            p.name as person_name, p.avatar_emoji, p.color_hex
       from chore_instances ci
       join chores c on c.id = ci.chore_id
       left join persons p on p.id = ci.person_id
      where ci.household_id = $1 and ci.proof_storage_key is not null
        and ci.status = 'done' and ci.deleted_at is null
      order by ci.completed_at desc nulls last`,
    [householdId]
  )
  return rows.map((r) => ({
    instanceId: r.id,
    choreTitle: r.chore_title,
    emoji: r.emoji,
    personName: r.person_name,
    personAvatar: r.avatar_emoji,
    personColor: r.color_hex,
    proofUrl: mediaUrl(r.proof_storage_key),
    completedAt: r.completed_at,
  }))
}

// Delete one stored proof: null the key/content-type (keep had_proof) + drop the
// blob. Returns false when there's nothing to delete.
export async function deleteStoredProof(householdId: string, id: string): Promise<boolean> {
  const prev = await query<{ proof_storage_key: string | null }>(
    `select proof_storage_key from chore_instances
       where household_id = $1 and id = $2 and proof_storage_key is not null and deleted_at is null`,
    [householdId, id]
  )
  const { rowCount } = await query(
    `update chore_instances set proof_storage_key = null, proof_content_type = null
       where household_id = $1 and id = $2 and proof_storage_key is not null and deleted_at is null`,
    [householdId, id]
  )
  if (rowCount) deleteBlob(prev.rows[0]?.proof_storage_key)
  return !!rowCount
}

// Delete every stored (settled) proof for a household. Returns how many.
export async function clearStoredProofs(householdId: string): Promise<number> {
  const { rows } = await query<{ proof_storage_key: string }>(
    `with cleared as (
       select id, proof_storage_key from chore_instances
        where household_id = $1 and proof_storage_key is not null
          and status = 'done' and deleted_at is null
        for update
     ), upd as (
       update chore_instances ci set proof_storage_key = null, proof_content_type = null
         from cleared e where ci.id = e.id
     )
     select proof_storage_key from cleared`,
    [householdId]
  )
  for (const r of rows) deleteBlob(r.proof_storage_key)
  return rows.length
}
