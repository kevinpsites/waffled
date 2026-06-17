// Per-person + whole-family overview — the "how is everyone doing" rollups behind
// the person profile (the "Person / Wally" mock) and the family dashboard. Pure
// aggregation over goals + the stars ledger + reward redemptions; no new tables.
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { requireTenant } from '../households/households'
import { listGoals } from '../goals/goals.service'

type Api = ReturnType<typeof createAPI>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The five life categories on a goal (goals.category).
export const CATEGORIES = ['physical', 'intellectual', 'spiritual', 'creative', 'social'] as const
const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
  physical: { emoji: '🏃', label: 'Physical' },
  intellectual: { emoji: '📚', label: 'Intellectual' },
  spiritual: { emoji: '🧘', label: 'Spiritual' },
  creative: { emoji: '🎨', label: 'Creative' },
  social: { emoji: '🤝', label: 'Social' },
}
// Gentle, local "what's missing" suggestions (no AI) per under-represented area.
const SUGGESTIONS: Record<string, string[]> = {
  physical: ['Bike 50 miles this month', 'Learn to do a cartwheel'],
  intellectual: ['Read 5 chapter books', 'Master the times tables'],
  spiritual: ['Gratitude journal for 30 days', '10 minutes of quiet each morning'],
  creative: ['Learn 5 songs on the ukulele', 'Build a Lego city'],
  social: ['Write 5 thank-you notes', 'Plan a friend hangout'],
}

interface PersonRow {
  id: string
  name: string | null
  avatar_emoji: string | null
  color_hex: string | null
  birthday: string | null
  member_type: string
}

function ageFrom(birthday: string | null): number | null {
  if (!birthday) return null
  const b = new Date(birthday + 'T00:00:00Z')
  const now = new Date()
  let age = now.getUTCFullYear() - b.getUTCFullYear()
  const m = now.getUTCMonth() - b.getUTCMonth()
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--
  return age >= 0 && age < 130 ? age : null
}

// A person's goals with *their* progress (per-person when each_tracks, the pooled
// total when shared_total).
function personGoals(allGoals: Awaited<ReturnType<typeof listGoals>>, personId: string) {
  return allGoals
    .filter((g) => g.participants.some((p: { personId: string }) => p.personId === personId))
    .map((g) => {
      const mine = g.participants.find((p: { personId: string }) => p.personId === personId)
      const progress = g.trackingMode === 'each_tracks' ? Number(mine?.progress ?? 0) : g.totalProgress
      const target = g.trackingMode === 'each_tracks' ? Number(mine?.target ?? g.target ?? 0) : g.target
      const pct = target ? Math.min(100, Math.round((progress / target) * 100)) : null
      return {
        id: g.id,
        title: g.title,
        emoji: g.emoji,
        category: g.category,
        goalType: g.goalType,
        unit: g.unit,
        progress,
        target,
        pct,
        streakDays: g.streakDays,
        milestoneReached: g.milestoneReached,
        milestoneTotal: g.milestoneTotal,
      }
    })
}

function categoryBalance(goals: ReturnType<typeof personGoals>) {
  return CATEGORIES.map((cat) => {
    const cg = goals.filter((g) => (g.category ?? '').toLowerCase() === cat)
    const avgPct = cg.length ? Math.round(cg.reduce((s, g) => s + (g.pct ?? 0), 0) / cg.length) : 0
    return { category: cat, emoji: CATEGORY_META[cat].emoji, label: CATEGORY_META[cat].label, goalCount: cg.length, avgPct }
  })
}

// Deterministic insight: which categories they lean into, which they're light on,
// and a couple of nudges for a missing area.
function buildInsight(balance: ReturnType<typeof categoryBalance>, name: string | null) {
  const withGoals = balance.filter((c) => c.goalCount > 0).sort((a, b) => b.goalCount - a.goalCount)
  const without = balance.filter((c) => c.goalCount === 0)
  const who = name ?? 'They'
  if (withGoals.length === 0) {
    return { lean: [], light: CATEGORIES.slice(), suggestions: SUGGESTIONS.physical.slice(0, 1), text: `No goals yet — pick a first one to get ${who} started.` }
  }
  const lean = withGoals.slice(0, 2).map((c) => c.label)
  const light = without.map((c) => c.label)
  const gap = without[0]?.category
  const suggestions = gap ? SUGGESTIONS[gap].slice(0, 2) : []
  const leanText = lean.length === 2 ? `${lean[0]} & ${lean[1]}` : lean[0]
  const text = light.length
    ? `${who} leans ${leanText}. Light on ${light[0].toLowerCase()} right now.`
    : `${who} has a nicely balanced set of goals across the board.`
  return { lean, light, suggestions, text }
}

export async function personOverview(householdId: string, personId: string) {
  const pr = await query<PersonRow>(
    `select id, name, avatar_emoji, color_hex, birthday::text, member_type
       from persons where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, personId]
  )
  const person = pr.rows[0]
  if (!person) return null

  const goals = personGoals(await listGoals(householdId), personId)
  const balance = categoryBalance(goals)

  const bal = await query<{ b: string }>(
    `select coalesce(sum(amount),0) as b from ledger_entries
       where household_id=$1 and person_id=$2 and currency='stars' and deleted_at is null`,
    [householdId, personId]
  )
  const recent = await query<{ amount: number; reason: string; created_at: string }>(
    `select amount, reason, created_at from ledger_entries
       where household_id=$1 and person_id=$2 and deleted_at is null order by created_at desc limit 8`,
    [householdId, personId]
  )
  const redemptions = await query<{ id: string; title: string; emoji: string | null; cost: number; status: string; created_at: string }>(
    `select id, title, emoji, cost, status, created_at from reward_redemptions
       where household_id=$1 and person_id=$2 and deleted_at is null order by created_at desc limit 8`,
    [householdId, personId]
  )

  return {
    person: { id: person.id, name: person.name, avatarEmoji: person.avatar_emoji, colorHex: person.color_hex, age: ageFrom(person.birthday), memberType: person.member_type },
    activeGoals: goals.length,
    topStreak: goals.reduce((m, g) => Math.max(m, g.streakDays), 0),
    stars: Number(bal.rows[0]?.b ?? 0),
    goals,
    categoryBalance: balance,
    insight: buildInsight(balance, person.name),
    recentLedger: recent.rows.map((r) => ({ amount: r.amount, reason: r.reason, createdAt: r.created_at })),
    redemptions: redemptions.rows.map((r) => ({ id: r.id, title: r.title, emoji: r.emoji, cost: r.cost, status: r.status, createdAt: r.created_at })),
  }
}

export async function familyOverview(householdId: string) {
  const people = await query<PersonRow>(
    `select id, name, avatar_emoji, color_hex, birthday::text, member_type
       from persons where household_id=$1 and deleted_at is null order by sort_order, created_at`,
    [householdId]
  )
  const allGoals = await listGoals(householdId)
  const balances = await query<{ person_id: string; b: string }>(
    `select person_id, sum(amount) as b from ledger_entries
       where household_id=$1 and currency='stars' and deleted_at is null group by person_id`,
    [householdId]
  )
  const starsByPerson = new Map(balances.rows.map((r) => [r.person_id, Number(r.b)]))

  return {
    people: people.rows.map((p) => {
      const goals = personGoals(allGoals, p.id)
      const avgPct = goals.length ? Math.round(goals.reduce((s, g) => s + (g.pct ?? 0), 0) / goals.length) : 0
      return {
        personId: p.id,
        name: p.name,
        avatarEmoji: p.avatar_emoji,
        colorHex: p.color_hex,
        age: ageFrom(p.birthday),
        activeGoals: goals.length,
        avgProgressPct: avgPct,
        topStreak: goals.reduce((m, g) => Math.max(m, g.streakDays), 0),
        stars: starsByPerson.get(p.id) ?? 0,
      }
    }),
  }
}

export function registerOverviewRoutes(api: Api): void {
  api.get('/api/family/overview', async (req: Request) => {
    const tenant = await requireTenant(req)
    return familyOverview(tenant.householdId)
  })

  api.get('/api/persons/:id/overview', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const overview = await personOverview(tenant.householdId, id)
    if (!overview) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return overview
  })
}
