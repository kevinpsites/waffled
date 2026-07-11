// Weekly digest — the "here's your week" email. Deliberately does NOT use the LLM
// heads-up card: this runs unattended on a schedule, so it's built from deterministic
// SQL (calendar + meals + chores + grocery) that's cheap, offline, and easy to test.
// Honors the household's digest_sections preference. Rendering lives in ./templates.
import { DateTime } from 'luxon'
import { query } from '../../platform/db'
import { renderDigest, type DigestData } from './templates'

const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MEAL_ORDER: Record<string, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 }

// UTC-ISO bounds for the household-local [weekStart, weekStart+7) window.
function weekWindow(weekStart: string, tz: string): { startIso: string; endIso: string; endDate: string } {
  const start = DateTime.fromISO(weekStart, { zone: tz }).startOf('day')
  const end = start.plus({ days: 7 })
  return { startIso: start.toUTC().toISO()!, endIso: end.toUTC().toISO()!, endDate: end.toISODate()! }
}

// Normalize a column value to a luxon DateTime in the household timezone. Two shapes
// arrive: a timestamptz (node-postgres gives a JS Date — an absolute instant, so
// convert it into tz) and a date-only 'YYYY-MM-DD' string (must be interpreted AT
// midnight in tz, not converted, or it can slip to the previous day).
function toLocal(v: string | Date, tz: string): DateTime {
  return v instanceof Date
    ? DateTime.fromJSDate(v).setZone(tz)
    : DateTime.fromISO(v, { zone: tz })
}

function dayLabel(v: string | Date, tz: string): string {
  const dt = toLocal(v, tz)
  return `${DOW[dt.weekday]} ${dt.day}`
}

// Build the digest for one household + week-start (a household-local YYYY-MM-DD).
// `sections` defaults to all four; callers pass the household's stored preference.
export async function buildWeeklyDigest(
  householdId: string,
  weekStart: string,
  sections: string[] = ['calendar', 'meals', 'grocery', 'chores']
): Promise<{ subject: string; html: string; text: string }> {
  const h = await query<{ name: string; timezone: string }>(
    `select name, timezone from households where id = $1`,
    [householdId]
  )
  const householdName = h.rows[0]?.name ?? 'Your household'
  const tz = h.rows[0]?.timezone ?? 'UTC'
  const { startIso, endIso, endDate } = weekWindow(weekStart, tz)
  const want = new Set(sections)

  const data: DigestData = {
    householdName,
    weekLabel: `${DateTime.fromISO(weekStart, { zone: tz }).toFormat('LLL d')}–${DateTime.fromISO(endDate, { zone: tz }).minus({ days: 1 }).toFormat('LLL d')}`,
    sections,
    events: [],
    meals: [],
    choresDue: 0,
    choresByPerson: [],
    groceryOpen: 0,
    grocerySample: [],
  }

  if (want.has('calendar')) {
    const { rows } = await query<{ title: string; starts_at: string | Date; all_day: boolean }>(
      `select title, starts_at, all_day from events
        where household_id = $1 and deleted_at is null and status <> 'cancelled'
          and starts_at >= $2 and starts_at < $3
        order by starts_at`,
      [householdId, startIso, endIso]
    )
    data.events = rows.map((e) => ({
      day: dayLabel(e.starts_at, tz),
      time: e.all_day ? 'All day' : toLocal(e.starts_at, tz).toFormat('h:mm a'),
      title: e.title,
    }))
  }

  if (want.has('meals')) {
    const { rows } = await query<{ date: string; meal_type: string; title: string | null }>(
      // Cast the date-only column to text so it's a clean 'YYYY-MM-DD' — avoids the
      // node-postgres "date parsed as a Date at server-local midnight" day-shift.
      `select e.date::text as date, e.meal_type, coalesce(r.title, e.title) as title
         from meal_plan_entries e
         join meal_plans p on p.id = e.meal_plan_id and p.deleted_at is null
         left join recipes r on r.id = e.recipe_id
        where e.household_id = $1 and e.date >= $2 and e.date < $3
        order by e.date`,
      [householdId, weekStart, endDate]
    )
    data.meals = rows
      .filter((m) => (m.title ?? '').trim() !== '')
      .sort((a, b) => a.date.localeCompare(b.date) || (MEAL_ORDER[a.meal_type] ?? 9) - (MEAL_ORDER[b.meal_type] ?? 9))
      .map((m) => ({
        day: dayLabel(m.date, tz),
        mealType: m.meal_type,
        title: (m.title ?? '').trim(),
      }))
  }

  if (want.has('chores')) {
    const { rows } = await query<{ name: string | null }>(
      `select p.name from chore_instances ci
         left join persons p on p.id = ci.person_id
        where ci.household_id = $1 and ci.deleted_at is null
          and ci.status = 'pending' and ci.due_on >= $2 and ci.due_on < $3`,
      [householdId, weekStart, endDate]
    )
    data.choresDue = rows.length
    const byName = new Map<string, number>()
    for (const r of rows) {
      const name = r.name ?? 'Unassigned'
      byName.set(name, (byName.get(name) ?? 0) + 1)
    }
    data.choresByPerson = [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }

  if (want.has('grocery')) {
    const { rows } = await query<{ name: string }>(
      `select li.name from list_items li
         join lists l on l.id = li.list_id and l.deleted_at is null and l.list_type = 'grocery'
        where li.household_id = $1 and li.deleted_at is null
          and li.checked = false and li.status = 'active'
        order by li.created_at`,
      [householdId]
    )
    data.groceryOpen = rows.length
    data.grocerySample = rows.slice(0, 10).map((r) => r.name)
  }

  const { html, text } = renderDigest(data)
  return { subject: `Your week at ${householdName} — ${data.weekLabel}`, html, text }
}
