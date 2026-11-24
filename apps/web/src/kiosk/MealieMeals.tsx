// Meals page while connected to Mealie: this week's plan and the recipe library.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useHousehold } from '../lib/api'
import { mealieApi, useMealieQuery, type MealieRecipeCard } from '../lib/api/mealie'
import { addDaysYmd, householdToday } from '../lib/household-date'
import { ConfirmDialog } from './components/ConfirmDialog'
import { MealieError } from './components/MealieError'
import { MealiePlanModal } from './components/MealiePlanModal'

const dayLabel = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const ORDER = ['breakfast', 'lunch', 'dinner', 'side']
const rank = (t: string) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Photo({ src, height }: { src: string | null | undefined; height: number }) {
  return src
    ? <img src={src} alt="" className="mealie-photo" style={{ height }} />
    : <div className="mealie-photo mealie-photo-ph" data-testid="recipe-placeholder" style={{ height }} />
}

function WeekTab({ tz, firstDay }: { tz: string; firstDay: number }) {
  const [offset, setOffset] = useState(0)
  const [planning, setPlanning] = useState(false)
  const [removing, setRemoving] = useState<{ id: number; title: string } | null>(null)
  const today = householdToday(tz)
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
  const start = addDaysYmd(today, -((dow - firstDay + 7) % 7) + offset * 7)
  const end = addDaysYmd(start, 6)
  const days = Array.from({ length: 7 }, (_, i) => addDaysYmd(start, i))
  const { data, error, retry } = useMealieQuery(() => mealieApi.mealplan(start, end), [start, end])

  return (
    <>
      <div className="mealie-bar">
        <button type="button" className="btn btn-ghost" aria-label="Previous week" onClick={() => setOffset((o) => o - 1)}>‹</button>
        <div className="wf-serif" style={{ fontWeight: 600 }}>{dayLabel(start)} – {dayLabel(end)}</div>
        <button type="button" className="btn btn-ghost" aria-label="Next week" onClick={() => setOffset((o) => o + 1)}>›</button>
        <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setPlanning(true)}>Plan a meal</button>
      </div>
      {error != null && <MealieError error={error} onRetry={retry} />}
      {!error && !data && <div className="muted" style={{ padding: 16 }}>Loading…</div>}
      {!error && data && days.map((d) => {
        const entries = data.entries.filter((e) => e.date === d).sort((a, b) => rank(a.entryType) - rank(b.entryType) || a.entryType.localeCompare(b.entryType))
        return (
          <div key={d} data-day={d} className="mealie-day">
            <div className="mealie-day-h">{dayLabel(d)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {entries.length === 0 && <div className="muted tiny">—</div>}
              {entries.map((e) => {
                const name = e.recipe?.name ?? e.title
                return (
                  <div key={e.id} className="mealie-entry">
                    <Photo src={e.recipe?.imageUrl} height={48} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="tiny muted" style={{ textTransform: 'uppercase', fontWeight: 700 }}>{cap(e.entryType)}</div>
                      {e.recipe
                        ? <Link to={`/meals/mealie/${e.recipe.slug}`} style={{ fontWeight: 600, color: 'inherit' }}>{name}</Link>
                        : <div style={{ fontWeight: 600 }}>{name}</div>}
                    </div>
                    <button type="button" className="btn btn-ghost" aria-label={`Remove ${name}`} onClick={() => setRemoving({ id: e.id, title: name })}>×</button>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      {planning && <MealiePlanModal onClose={() => setPlanning(false)} />}
      {removing && (
        <ConfirmDialog
          title="Remove from the plan?"
          message={`${removing.title} will be removed from Mealie's meal plan.`}
          confirmLabel="Remove"
          danger
          onConfirm={async () => { await mealieApi.unplan(removing.id); setRemoving(null) }}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}

function RecipesTab() {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [items, setItems] = useState<MealieRecipeCard[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [error, setError] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (search === debounced) return
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search, debounced])

  useEffect(() => {
    let alive = true
    setLoaded(false)
    mealieApi.recipes({ ...(debounced ? { search: debounced } : {}), page: 1 })
      .then((r) => { if (alive) { setItems(r.items); setPage(r.page); setTotalPages(r.totalPages); setError(null); setLoaded(true) } })
      .catch((e) => { if (alive) setError(e) })
    return () => { alive = false }
  }, [debounced, nonce])

  async function more() {
    try {
      const r = await mealieApi.recipes({ ...(debounced ? { search: debounced } : {}), page: page + 1 })
      setItems((cur) => [...cur, ...r.items])
      setPage(r.page)
      setTotalPages(r.totalPages)
    } catch (e) { setError(e) }
  }

  return (
    <>
      <label className="field" style={{ maxWidth: 420 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search recipes" />
      </label>
      {error != null && <MealieError error={error} onRetry={() => { setError(null); setNonce((n) => n + 1) }} />}
      {!error && !loaded && <div className="muted" style={{ padding: 16 }}>Loading…</div>}
      {!error && loaded && items.length === 0 && <div className="muted" style={{ padding: 16 }}>No recipes found.</div>}
      {!error && (
        <div className="mealie-grid">
          {items.map((r) => (
            <Link key={r.id} to={`/meals/mealie/${r.slug}`} className="card mealie-card">
              <Photo src={r.imageUrl} height={130} />
              <div style={{ padding: '10px 12px', fontWeight: 600 }}>{r.name}</div>
            </Link>
          ))}
        </div>
      )}
      {!error && page < totalPages && (
        <div style={{ textAlign: 'center', margin: '16px 0' }}>
          <button type="button" className="btn btn-ghost" onClick={more}>Load more</button>
        </div>
      )}
    </>
  )
}

export function MealieMeals() {
  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const firstDay = household?.weekStart === 'monday' ? 1 : 0
  const [tab, setTab] = useState<'week' | 'recipes'>('week')
  return (
    <div className="mealie-meals">
      <div className="mealie-tabs">
        <button type="button" className={`btn ${tab === 'week' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('week')}>This week</button>
        <button type="button" className={`btn ${tab === 'recipes' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('recipes')}>Recipes</button>
      </div>
      {tab === 'week' ? <WeekTab tz={tz} firstDay={firstDay} /> : <RecipesTab />}
    </div>
  )
}
