import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Icon } from './icons'
import { PlanWeek } from './components/PlanWeek'
import { PlanMonth } from './components/PlanMonth'
import { RecipeBrowser, MEALS, MEAL_LABEL, type MealType } from './components/RecipeBrowser'
import { useTopbarFull } from './topbar-slot'
import {
  api,
  useMealsWeek,
  useRecipes,
  localToday,
  type Recipe,
  type WeekEntry,
} from '../lib/api'
import { isEatingOut } from './components/MealsColumn'
import '../styles/meals.css'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
    <RecipeBrowser
      recipes={recipes}
      loading={loading}
      slot={slot}
      onPick={onPick}
      onView={onView}
      onEatingOut={onEatingOut}
      selectLabel={`Select for ${MEAL_LABEL[slot]}`}
    />
  )
}

// First day of the month containing `d`.
function monthStartOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function Meals() {
  const navigate = useNavigate()
  const [view, setView] = useState<'week' | 'month'>('week')
  // One anchor date; the week view reads its week, the month view its month.
  const [anchor, setAnchor] = useState<Date>(() => new Date())
  const [filter, setFilter] = useState<'all' | 'dinner'>('all')
  const [picking, setPicking] = useState<{ date: string; mealType: MealType; dayLabel: string } | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planningMonth, setPlanningMonth] = useState(false)

  const weekStartD = useMemo(() => weekStart(anchor), [anchor])
  const monthStartD = useMemo(() => monthStartOf(anchor), [anchor])
  // The month grid is a 6-week (42-day) block starting on the Sunday on/before the 1st.
  const gridStartD = useMemo(() => {
    const d = new Date(monthStartD)
    d.setDate(1 - d.getDay())
    return d
  }, [monthStartD])

  const startStr = ymd(weekStartD)
  const fetchStart = view === 'month' ? ymd(gridStartD) : startStr
  const fetchDays = view === 'month' ? 42 : 7
  const { entries, refetch } = useMealsWeek(fetchStart, fetchDays)
  const { recipes, loading: recipesLoading } = useRecipes()

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStartD, i)), [weekStartD])
  const monthCells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStartD, i)), [gridStartD])

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

  function openPicker(d: Date, mealType: MealType) {
    setPicking({
      date: ymd(d),
      mealType,
      dayLabel: `${DOW[d.getDay()]} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`,
    })
  }

  // Prev/next steps a week or a month depending on the view; "today" recenters.
  function step(delta: number) {
    setAnchor((a) => {
      const d = new Date(a)
      if (view === 'month') d.setMonth(d.getMonth() + delta)
      else d.setDate(d.getDate() + delta * 7)
      return d
    })
  }

  const rows: MealType[] = filter === 'dinner' ? ['dinner'] : [...MEALS]

  if (planning) {
    return <PlanWeek startStr={startStr} days={days} onClose={() => setPlanning(false)} onApplied={refetch} />
  }

  if (planningMonth) {
    return <PlanMonth monthStart={ymd(monthStartD)} onClose={() => setPlanningMonth(false)} onApplied={refetch} />
  }

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

  const monthLabel = monthStartD.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return (
    <div className="meals-screen">
      <div className="meals-head">
        <div className="card-h nk-serif" style={{ fontSize: 20 }}>{view === 'month' ? monthLabel : 'Meal plan'}</div>
        <div className="seg">
          <button className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}>Week</button>
          <button className={view === 'month' ? 'on' : ''} onClick={() => setView('month')}>Month</button>
        </div>
        {view === 'week' && (
          <div className="seg">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All meals</button>
            <button className={filter === 'dinner' ? 'on' : ''} onClick={() => setFilter('dinner')}>Dinners</button>
          </div>
        )}
        <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals/recipes')}>
          <Icon name="recipes" />
          <span>Explore recipes</span>
        </button>
        <button type="button" className="btn btn-ai" style={{ fontSize: 14, padding: '10px 18px' }} onClick={() => (view === 'month' ? setPlanningMonth(true) : setPlanning(true))}>
          <Icon name="spark" />
          {view === 'month' ? 'Plan my month' : 'Plan my week'}
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="pill meals-nav" aria-label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)}>
            <Icon name="cl" />
          </button>
          <button type="button" className="pill" onClick={() => setAnchor(new Date())}>{view === 'month' ? 'This month' : 'This week'}</button>
          <button type="button" className="pill meals-nav" aria-label={view === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)}>
            <Icon name="cr" />
          </button>
        </div>
      </div>
      <div className="meals-hint">
        {view === 'month' ? 'Dinners for the month · tap a night to add or open a recipe' : "Tap a meal for the recipe · tap + to add one · the avatar is who's cooking"}
      </div>

      {view === 'month' ? (
        <div className="meals-month">
          {DOW.map((d) => (
            <div key={d} className="mm-dow">{d}</div>
          ))}
          {monthCells.map((d) => {
            const dateStr = ymd(d)
            const entry = bySlot.get(`${dateStr}|dinner`)
            const inMonth = d.getMonth() === monthStartD.getMonth()
            const isToday = dateStr === localToday()
            return (
              <MonthCell
                key={dateStr}
                date={d}
                inMonth={inMonth}
                isToday={isToday}
                entry={entry}
                onOpen={() => (entry?.recipeId ? navigate(`/meals/recipe/${entry.recipeId}`) : openPicker(d, 'dinner'))}
                onAdd={() => openPicker(d, 'dinner')}
                onRemove={() => clearMeal(dateStr, 'dinner')}
              />
            )
          })}
        </div>
      ) : (
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
              onAdd={(d) => openPicker(d, mealType)}
              onRemove={clearMeal}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// One day in the month grid (dinner only). Empty cell shows a +; a planned night
// shows the emoji + title (clamped), with a remove ×. Recipe nights open the
// recipe; recipe-less / eating-out nights re-open the picker.
function MonthCell({
  date,
  inMonth,
  isToday,
  entry,
  onOpen,
  onAdd,
  onRemove,
}: {
  date: Date
  inMonth: boolean
  isToday: boolean
  entry: WeekEntry | undefined
  onOpen: () => void
  onAdd: () => void
  onRemove: () => void
}) {
  const out = entry ? isEatingOut(entry) : false
  const title = out ? 'Eating out' : entry?.recipe?.title ?? entry?.title ?? null
  const emoji = entry?.recipe?.emoji ?? (out ? '🍴' : '🍽️')
  return (
    <div className={`mm-cell ${inMonth ? '' : 'mm-out'} ${isToday ? 'mm-today' : ''}`} onClick={entry ? onOpen : onAdd} role="button" tabIndex={0}>
      <div className="mm-date">{date.getDate()}</div>
      {entry ? (
        <div className="mm-meal" title={title ?? undefined}>
          <span className="mm-emoji">{emoji}</span>
          <span className="mm-title">{title}</span>
          <button
            type="button"
            className="mm-remove"
            aria-label="Remove dinner"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            ×
          </button>
        </div>
      ) : (
        inMonth && <div className="mm-add"><Icon name="plus" /></div>
      )}
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
