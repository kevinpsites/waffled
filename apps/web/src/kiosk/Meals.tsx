import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Icon } from './icons'
import { RecipeModal } from './components/RecipeModal'
import { useTopbarFull } from './topbar-slot'
import {
  api,
  useMealsWeek,
  useRecipes,
  type Recipe,
  type WeekEntry,
  type MealSuggestion,
} from '../lib/api'
import '../styles/meals.css'

const VIA_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'local LLM' }

// AI "Plan my week": fetch dinner suggestions for the empty days and let the user
// accept them (each applies via the normal plan endpoint). Reuses the household's
// chosen LLM (Settings → AI & capture); 501 means no provider is set.
function PlanWeekModal({ startStr, onClose, onApplied }: { startStr: string; onClose: () => void; onApplied: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [via, setVia] = useState('')
  const [items, setItems] = useState<MealSuggestion[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .planWeek(startStr)
      .then((r) => alive && (setItems(r.suggestions), setVia(r.via), setLoading(false)))
      .catch((e: Error) => {
        if (!alive) return
        setError(/501/.test(e.message) ? 'Pick an AI provider first in Settings → AI & capture.' : 'Couldn’t plan the week — try again.')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [startStr])

  const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

  async function apply(s: MealSuggestion) {
    await api.planSlot(s.recipeId ? { date: s.date, mealType: 'dinner', recipeId: s.recipeId } : { date: s.date, mealType: 'dinner', title: s.title })
    setItems((xs) => xs.filter((x) => x.date !== s.date))
    onApplied()
  }
  async function applyAll() {
    setBusy(true)
    for (const s of items) {
      await api.planSlot(s.recipeId ? { date: s.date, mealType: 'dinner', recipeId: s.recipeId } : { date: s.date, mealType: 'dinner', title: s.title })
    }
    onApplied()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Plan my week</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
          {via && VIA_LABEL[via] ? `Dinner ideas via ${VIA_LABEL[via]} — accept the ones you like` : 'Dinner ideas for the empty nights'}
        </div>

        {loading && <div className="muted" style={{ padding: 16 }}>Thinking up dinners…</div>}
        {error && <div className="muted" style={{ padding: 16, fontWeight: 600 }}>{error}</div>}
        {!loading && !error && items.length === 0 && (
          <div className="muted" style={{ padding: 16, fontWeight: 600 }}>Every dinner this week is already planned. 🎉</div>
        )}

        {items.map((s) => (
          <div key={s.date} className="set-row2">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="set-row2-t">{s.title}{s.recipeId && <span className="tiny muted" style={{ fontWeight: 600 }}> · from your recipes</span>}</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>{dayLabel(s.date)}{s.note ? ` · ${s.note}` : ''}</div>
            </div>
            <button type="button" className="pill btn-primary" onClick={() => apply(s)}>Add</button>
          </div>
        ))}

        {!loading && !error && items.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={applyAll} disabled={busy}>
              {busy ? 'Adding…' : `Add all ${items.length}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const
const MEAL_LABEL: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
}
type MealType = (typeof MEALS)[number]

// Local YYYY-MM-DD (kiosk timezone).
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// Sunday that starts the week containing `d`.
function weekStart(d: Date): Date {
  const s = new Date(d)
  s.setHours(0, 0, 0, 0)
  s.setDate(s.getDate() - s.getDay())
  return s
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

// Map a recipe/category to one of nook.css's food gradient classes so picker
// cards and avatars echo the mock's tinted tiles.
const GRAD_BY_CATEGORY: Record<string, string> = {
  breakfast: 'g-pan',
  lunch: 'g-veg',
  dinner: 'g-pasta',
  snack: 'g-cookie',
  dessert: 'g-cookie',
}
function gradClass(r: { category: string | null }): string {
  return (r.category && GRAD_BY_CATEGORY[r.category.toLowerCase()]) || 'g-veg'
}

function PlannedCell({ entry, mealType, onOpen, onRemove }: { entry: WeekEntry; mealType: MealType; onOpen: () => void; onRemove: () => void }) {
  const title = entry.recipe?.title ?? entry.title ?? 'Planned'
  return (
    <div className={`meals-cell ${mealType}`} onClick={onOpen} role="button" tabIndex={0} aria-label={`${MEAL_LABEL[mealType]}: ${title}`}>
      {entry.cook && (
        <div
          className="meal-cook"
          style={{ background: entry.cook.colorHex ? `${entry.cook.colorHex}22` : undefined }}
          title={entry.cook.name ? `Cooking: ${entry.cook.name}` : 'Cooking'}
        >
          {entry.cook.avatarEmoji ?? '🧑‍🍳'}
        </div>
      )}
      <button
        type="button"
        className="meal-remove"
        aria-label={`Remove ${title}`}
        title="Remove from this day"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
      <div className="meal-t">{title}</div>
    </div>
  )
}

function AddCell({ onAdd, label }: { onAdd: () => void; label: string }) {
  return (
    <div className="meals-cell meals-add" onClick={onAdd} role="button" tabIndex={0} aria-label={label}>
      <Icon name="plus" />
    </div>
  )
}

// The full-screen recipe picker shown when tapping "+" on an empty slot
// (mock: meals-picker.png, "Add a dinner · this day"). Replaces the topbar with
// a back / title / search chrome and fills the body with a 4-up recipe grid.
function MealPicker({
  slot,
  dayLabel,
  recipes,
  loading,
  onPick,
  onView,
  onEatingOut,
  onClose,
}: {
  slot: MealType
  dayLabel: string
  recipes: Recipe[]
  loading: boolean
  onPick?: (recipe: Recipe) => void
  onView?: (recipe: Recipe) => void
  onEatingOut?: () => void
  onClose: () => void
}) {
  const browse = !onPick
  const [filter, setFilter] = useState<'all' | MealType>(browse ? 'all' : slot)
  const [preview, setPreview] = useState<Recipe | null>(null)
  // 'all' shows everything; a meal filter shows recipes tagged with it (or untagged,
  // which fit any slot). No more "fall back to all" when a filter has no matches.
  const shown = filter === 'all' ? recipes : recipes.filter((r) => !r.category || r.category.toLowerCase() === filter)
  const FILTERS: Array<'all' | MealType> = ['all', ...MEALS]

  useTopbarFull(
    () => (
      <>
        <div className="pill" onClick={onClose} style={{ padding: '9px 14px 9px 11px', cursor: 'pointer' }}>
          <Icon name="cl" />
          Meals
        </div>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>
          {browse ? 'Explore recipes' : `Add a ${MEAL_LABEL[slot].toLowerCase()} · ${dayLabel}`}
        </div>
        <div className="tb-right" style={{ marginLeft: 'auto' }}>
          <div className="ai-bar" style={{ width: 280, padding: '8px 10px 8px 14px' }}>
            <div className="ai-spark" style={{ width: 26, height: 26 }}>
              <Icon name="spark" />
            </div>
            <div className="ph" style={{ fontSize: 14 }}>
              Search or paste a recipe…
            </div>
          </div>
        </div>
      </>
    ),
    [slot, dayLabel]
  )

  return (
    <div className="meals-picker">
      <div className="picker-filters">
        {FILTERS.map((f) => (
          <div
            key={f}
            className={`mp-filter tag ${f === filter ? 'on' : ''}`}
            onClick={() => setFilter(f)}
            role="button"
            tabIndex={0}
          >
            {f === 'all' ? 'All' : MEAL_LABEL[f]}
          </div>
        ))}
        <div className="tiny muted picker-count">
          {shown.length} {filter === 'all' ? 'recipe' : MEAL_LABEL[filter].toLowerCase() + ' idea'}
          {shown.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="picker-grid">
        {onEatingOut && (
          <div className="rc mp-card" role="button" tabIndex={0} onClick={onEatingOut}>
            <div className="rc-img" style={{ background: 'linear-gradient(135deg,#d9e7f6,#bcd0e9)', fontSize: 34, display: 'grid', placeItems: 'center' }}>🍴</div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>Eating out</div>
              <div className="rc-m"><span>No cooking tonight</span></div>
              <div className="mp-actions">
                <button type="button" className="pill btn-primary mp-select" onClick={(e) => { e.stopPropagation(); onEatingOut() }}>Select</button>
              </div>
            </div>
          </div>
        )}
        {loading && <div className="muted picker-empty">Loading recipes…</div>}
        {!loading && shown.length === 0 && (
          <div className="muted picker-empty">
            {filter === 'all' ? 'No recipes yet.' : `No ${MEAL_LABEL[filter].toLowerCase()} recipes yet — tag a recipe with this meal to see it here.`}
          </div>
        )}
        {shown.map((r) => (
          <div key={r.id} className="rc mp-card" role="button" tabIndex={0} onClick={() => (onView ? onView(r) : setPreview(r))}>
            <div className={`rc-img ${gradClass(r)}`}>{r.emoji ?? '🍽️'}</div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>{r.title}</div>
              <div className="rc-m">
                {r.cookTimeMinutes != null && <span>🕐 {r.cookTimeMinutes} min</span>}
                {r.category && <span>{r.category}</span>}
              </div>
              <div className="mp-actions">
                <button type="button" className="pill" onClick={(e) => { e.stopPropagation(); onView ? onView(r) : setPreview(r) }}>View</button>
                {onPick && (
                  <button type="button" className="pill btn-primary mp-select" onClick={(e) => { e.stopPropagation(); onPick(r) }}>Select</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <RecipeModal
          recipeId={preview.id}
          onClose={() => setPreview(null)}
          onSelect={onPick ? () => onPick(preview) : undefined}
          selectLabel={onPick ? `Select for ${MEAL_LABEL[slot]}` : undefined}
        />
      )}
    </div>
  )
}

export function Meals() {
  const navigate = useNavigate()
  const [start, setStart] = useState<Date>(() => weekStart(new Date()))
  const [filter, setFilter] = useState<'all' | 'dinner'>('all')
  const [picking, setPicking] = useState<{ date: string; mealType: MealType; dayLabel: string } | null>(null)
  const [planning, setPlanning] = useState(false)

  const startStr = ymd(start)
  const { entries, refetch } = useMealsWeek(startStr)
  const { recipes, loading: recipesLoading } = useRecipes()

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start])

  // entries keyed by `${date}|${mealType}`.
  const bySlot = useMemo(() => {
    const m = new Map<string, WeekEntry>()
    for (const e of entries) m.set(`${e.date}|${e.mealType}`, e)
    return m
  }, [entries])

  async function pick(recipe: Recipe) {
    if (!picking) return
    await api.planSlot({ date: picking.date, mealType: picking.mealType, recipeId: recipe.id })
    setPicking(null)
    refetch()
  }

  async function clearMeal(date: string, mealType: MealType) {
    await api.clearSlot(date, mealType)
    refetch()
  }

  async function eatOut() {
    if (!picking) return
    await api.planSlot({ date: picking.date, mealType: picking.mealType, title: 'Eating out' })
    setPicking(null)
    refetch()
  }

  const rows: MealType[] = filter === 'dinner' ? ['dinner'] : [...MEALS]

  if (picking) {
    return (
      <MealPicker
        slot={picking.mealType}
        dayLabel={picking.dayLabel}
        recipes={recipes}
        loading={recipesLoading}
        onPick={pick}
        onEatingOut={eatOut}
        onClose={() => setPicking(null)}
      />
    )
  }

  return (
    <div className="meals-screen">
      <div className="meals-head">
        <div className="card-h nk-serif" style={{ fontSize: 20 }}>Meal plan</div>
        <div className="seg">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All meals</button>
          <button className={filter === 'dinner' ? 'on' : ''} onClick={() => setFilter('dinner')}>Dinners</button>
        </div>
        <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals/recipes')}>
          <Icon name="recipes" />
          <span>Explore recipes</span>
        </button>
        <button type="button" className="btn btn-ai" style={{ fontSize: 14, padding: '10px 18px' }} onClick={() => setPlanning(true)}>
          <Icon name="spark" />
          Plan my week
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="pill meals-nav" aria-label="Previous week" onClick={() => setStart((s) => addDays(s, -7))}>
            <Icon name="cl" />
          </button>
          <button type="button" className="pill" onClick={() => setStart(weekStart(new Date()))}>This week</button>
          <button type="button" className="pill meals-nav" aria-label="Next week" onClick={() => setStart((s) => addDays(s, 7))}>
            <Icon name="cr" />
          </button>
        </div>
      </div>
      <div className="meals-hint">Tap a meal for the recipe · tap + to add one · the avatar is who's cooking</div>

      <div className="meals-grid" style={{ gridTemplateRows: `auto repeat(${rows.length}, 1fr)` }}>
        <div />
        {days.map((d) => (
          <div key={d.toISOString()} className="meals-dow">
            <div className="dow">{DOW[d.getDay()]}</div>
            <div className="date">{d.getDate()}</div>
          </div>
        ))}

        {rows.map((mealType) => (
          <Row
            key={mealType}
            mealType={mealType}
            days={days}
            bySlot={bySlot}
            onOpen={(id) => navigate(`/meals/recipe/${id}`)}
            onAdd={(d) =>
              setPicking({
                date: ymd(d),
                mealType,
                dayLabel: `${DOW[d.getDay()]} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`,
              })
            }
            onRemove={clearMeal}
          />
        ))}
      </div>

      {planning && <PlanWeekModal startStr={startStr} onClose={() => setPlanning(false)} onApplied={refetch} />}
    </div>
  )
}

function Row({
  mealType,
  days,
  bySlot,
  onOpen,
  onAdd,
  onRemove,
}: {
  mealType: MealType
  days: Date[]
  bySlot: Map<string, WeekEntry>
  onOpen: (recipeId: string) => void
  onAdd: (d: Date) => void
  onRemove: (date: string, mealType: MealType) => void
}) {
  return (
    <>
      <div className="meals-rowlabel">
        <span>{MEAL_LABEL[mealType]}</span>
      </div>
      {days.map((d) => {
        const dateStr = ymd(d)
        const entry = bySlot.get(`${dateStr}|${mealType}`)
        if (entry) {
          return (
            <PlannedCell
              key={dateStr}
              entry={entry}
              mealType={mealType}
              // Recipe → open it; recipe-less ("Fish"/eating-out) → open the slot
              // picker so you can attach a recipe or change the plan.
              onOpen={() => (entry.recipeId ? onOpen(entry.recipeId) : onAdd(d))}
              onRemove={() => onRemove(dateStr, mealType)}
            />
          )
        }
        return (
          <AddCell
            key={dateStr}
            onAdd={() => onAdd(d)}
            label={`Add ${MEAL_LABEL[mealType].toLowerCase()} for ${DOW[d.getDay()]} ${d.getDate()}`}
          />
        )
      })}
    </>
  )
}
