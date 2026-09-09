import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { mealBuilderApi, mealsApi, personsApi, planningMealsApi, useRecipes, type Meal, type Person } from '../../../lib/api'
import { isEatingOut } from '../../components/MealsColumn'
import { PlanWeek } from '../../components/PlanWeek'
import { RecipeBrowser } from '../../components/RecipeBrowser'
import type {
  PlanCard,
  PlanningMealsView,
  PlanningMealsNight,
  PlanningNightDinner,
  PlanningNightEvent,
  PlanningFilledNight,
  PlanningShoppingTrip,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-meals.css'

// Step 7 · Meals — the same seven columns as Calendar, each night showing its events above the
// dish. The plan already in the app is shown as-is; "Plan the rest for me" fills only the
// empties and marks them undoable.
//
// The step OWNS NO DATA: everything on screen is the existing meal plan and both edits go
// through the endpoints the Meals screen uses; the session records only a crumb (which nights
// were auto-filled).
//
// WHY THERE IS A STORE IN THIS FILE: the shell renders `Body` and `FooterExtra` as two sibling
// trees, and the footer's fill is what marks nights in the body. Module-scoped and keyed by
// session+week, so another week can't inherit these marks.

const MEAL_TYPE = 'dinner'

interface StepState {
  key: string
  view: PlanningMealsView | null
  loading: boolean
  error: string | null
  busy: boolean
  // The auto-filled nights that are STILL undoable, each carrying the receipt the server
  // checks. ONLY the fill can put something here: a claim rebuilt from the session crumb on a
  // revisit would be compared against the very row it was read from, so the guard would always
  // pass and "Undo the three" would clear a night somebody had since changed by hand.
  filled: PlanningFilledNight[]
  // Display only: nights the crumb says were auto-filled. They keep the ✨ across a revisit
  // but do not make the undo live.
  autoMarks: string[]
  kept: string[]
  groceryAdded: number | null
  people: Person[] | null
  // Here rather than a `useState` because the button that opens it is in `FooterExtra` while
  // the planner renders from `Body` — two sibling trees, same store.
  planner: boolean
}

const EMPTY: StepState = { key: '', view: null, loading: true, error: null, busy: false, filled: [], autoMarks: [], kept: [], groceryAdded: null, people: null, planner: false }

let state: StepState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state
function set(patch: Partial<StepState>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

function crumbDates(data: Record<string, unknown> | undefined): string[] {
  const raw = data?.autoFilled
  if (!Array.isArray(raw)) return []
  return raw.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
}

async function load(key: string, weekStart: string, seed: string[]) {
  set({ ...EMPTY, key, people: state.people })
  try {
    const view = await planningMealsApi.get(weekStart)
    if (state.key !== key) return // a later week won the race
    // The crumb restores the MARKS, never the undo: see `filled` above.
    const stillPlanned = new Set(view.nights.filter((n) => n.dinner).map((n) => n.date))
    set({ view, loading: false, autoMarks: seed.filter((d) => stillPlanned.has(d)) })
  } catch {
    if (state.key !== key) return
    set({ loading: false, error: "Couldn't read this week's meals — reload and try again." })
  }
}

async function reread(weekStart: string) {
  const key = state.key
  // Pass the trip's chore id back: it is what keeps a renamed chore recognised as this week's
  // trip instead of spawning a second one.
  const view = await planningMealsApi.get(weekStart, state.view?.shopping?.choreId ?? null)
  if (state.key === key) set({ view })
}

async function setShopper(weekStart: string, t: { dueOn: string | null; personId: string | null; dueTime: string | null }, refresh: () => void) {
  if (state.busy) return
  set({ busy: true, error: null })
  try {
    const r = await planningMealsApi.setShopper(weekStart, { ...t, choreId: state.view?.shopping?.choreId ?? null })
    set({ view: r.view, busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

const forget = (date: string) => ({
  filled: state.filled.filter((f) => f.date !== date),
  autoMarks: state.autoMarks.filter((d) => d !== date),
})

// Both components read the same state; `primary` (only Body passes it) says which one owns the
// fetching, so a remount doesn't fire two reads.
function useMealsStep(p: StepBodyProps, primary = false): StepState {
  const key = `${p.sessionId}|${p.weekStart}`
  const seed = useMemo(() => crumbDates(p.step.data), [p.step.data])
  useEffect(() => {
    if (state.key !== key) void load(key, p.weekStart, seed)
    else if (primary && !state.loading) void reread(p.weekStart).catch(() => { /* the columns simply stay as they were */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useSyncExternalStore(subscribe, snapshot)
}

// ── The two writes the footer drives ─────────────────────────────────────────────

// The approved week, applied through the step's own fill endpoint rather than the planner's
// per-slot writes, for the two things only that endpoint does: refuse a night somebody already
// decided, and hand back the receipt the undo checks (see `filled` above).
async function applyPlan(weekStart: string, cards: PlanCard[], refresh: () => void) {
  // The planner closes as soon as this resolves, so bailing out quietly would report a week
  // that was never written — another write in flight is the only way here, and it must SAY so.
  if (state.busy) {
    set({ error: "Something else was still saving — the week wasn't planned. Try again." })
    return
  }
  set({ busy: true, error: null, kept: [] })
  const groceriesBefore = state.view?.groceries?.items ?? null
  try {
    const r = await planningMealsApi.fill(weekStart, cards)
    const fresh = new Set(r.filled.map((f) => f.date))
    const after = r.view.groceries?.items ?? null
    const added = groceriesBefore !== null && after !== null ? after - groceriesBefore : null
    set({
      view: r.view,
      busy: false,
      filled: [...state.filled.filter((f) => !fresh.has(f.date)), ...r.filled].sort((a, b) => a.date.localeCompare(b.date)),
      autoMarks: state.autoMarks.filter((d) => !fresh.has(d)),
      groceryAdded: r.filled.length && added !== null && added > 0 ? added : null,
    })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

async function runUndo(weekStart: string, refresh: () => void) {
  if (state.busy || !state.filled.length) return
  set({ busy: true, error: null, kept: [], groceryAdded: null })
  try {
    const r = await planningMealsApi.undo(weekStart, state.filled)
    const settled = new Set([...r.cleared, ...r.kept])
    set({
      view: r.view,
      busy: false,
      kept: r.kept,
      filled: state.filled.filter((f) => !settled.has(f.date)),
      autoMarks: state.autoMarks.filter((d) => !settled.has(d)),
    })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// ── A night, decided by hand ─────────────────────────────────────────────────────

async function planNight(weekStart: string, date: string, slot: { recipeId?: string | null; title?: string | null }, refresh: () => void) {
  if (state.busy) {
    set({ error: "Something else was still saving — that night wasn't planned. Try again." })
    return
  }
  set({ busy: true, error: null })
  try {
    await mealsApi.planSlot({ date, mealType: MEAL_TYPE, ...slot })
    set({ ...forget(date), kept: [], groceryAdded: null })
    await reread(weekStart)
    set({ busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// A PLATE — a saved meal dropped whole onto the night — cannot go through `planSlot`: it is
// scheduled by POST /api/meals/:id/schedule, which is where copy-on-schedule lives (editing
// next week's BBQ Sunday must not rewrite the one that already went out). That endpoint writes
// through the same `upsertEntry` the fill uses, so a plate night is an ordinary planned night
// everywhere else in this step — including the undo, which compares meal_id.
async function planPlate(weekStart: string, date: string, mealId: string, refresh: () => void) {
  if (state.busy) {
    set({ error: "Something else was still saving — that night wasn't planned. Try again." })
    return
  }
  set({ busy: true, error: null })
  try {
    await mealBuilderApi.schedule(mealId, { date, mealType: MEAL_TYPE })
    set({ ...forget(date), kept: [], groceryAdded: null })
    await reread(weekStart)
    set({ busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

async function clearNight(weekStart: string, date: string, refresh: () => void) {
  if (state.busy) {
    set({ error: "Something else was still saving — that night wasn't cleared. Try again." })
    return
  }
  set({ busy: true, error: null })
  try {
    await mealsApi.clearSlot(date, MEAL_TYPE)
    set({ ...forget(date), kept: [], groceryAdded: null })
    await reread(weekStart)
    set({ busy: false })
  } catch {
    set({ busy: false, error: "That didn't take — try again." })
  }
  refresh()
}

// ── Formatting ───────────────────────────────────────────────────────────────────
// Noon, not midnight: a bare YYYY-MM-DD parses as UTC and would render the previous weekday
// west of Greenwich. Matches PlanWeek.tsx.
const at = (date: string) => new Date(`${date}T12:00:00`)
const dow = (date: string) => at(date).toLocaleDateString(undefined, { weekday: 'short' })
const dayNum = (date: string) => at(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const clock = (e: PlanningNightEvent) =>
  e.allDay ? 'All day' : new Date(e.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function attribution(d: PlanningNightDinner, auto: boolean, out: boolean): ReactNode {
  if (d.cookName) {
    return (
      <>
        <span aria-hidden>{d.cookAvatar ?? '👤'}</span> {d.cookName}
      </>
    )
  }
  if (auto) return 'the app picked this'
  if (d.mealId) return 'a whole plate'
  if (d.minutes) return `${d.minutes} min`
  if (out) return 'no cooking'
  return null
}

function tripLabel(t: PlanningShoppingTrip | null): string {
  if (!t) return "Who's shopping?"
  const when = `${dow(t.dueOn)}${t.dueTime ? ` ${t.dueTime}` : ''}`
  if (!t.personName) return `Up for grabs · ${when}`
  return `${t.personAvatar ?? '\u{1F464}'} ${t.personName} shops ${when}`
}

// "Undo the three" is the design's own phrasing, so small counts read as words.
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']
const countWord = (n: number) => WORDS[n] ?? String(n)

// ── Body ─────────────────────────────────────────────────────────────────────────

function Body(p: StepBodyProps) {
  const s = useMealsStep(p, true)
  const [editing, setEditing] = useState<string | null>(null)
  const [shopping, setShopping] = useState(false)
  const autoDates = useMemo(
    () => new Set([...s.filled.map((f) => f.date), ...s.autoMarks]),
    [s.filled, s.autoMarks]
  )

  useEffect(() => {
    const dates = [...autoDates].sort()
    p.setDecisionData(dates.length ? { autoFilled: dates } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDates])

  useEffect(() => { setEditing(null); setShopping(false); if (state.planner) set({ planner: false }) }, [s.key])

  // The nights the planner may touch. Noon-local, like every date on this screen: a bare
  // YYYY-MM-DD parses as UTC and PlanWeek reads the day back with local getters.
  const emptyDays = useMemo(() => (s.view?.emptyDates ?? []).map(at), [s.view?.emptyDates])

  if (s.loading) return <div className="wpm-msg">Reading the week…</div>
  if (!s.view) return <div className="wpm-msg">{s.error ?? "Couldn't read this week's meals."}</div>

  const night = editing ? s.view.nights.find((n) => n.date === editing) ?? null : null

  return (
    <div className="wpm">
      <div className="wpm-week">
        {s.view.nights.map((n) => (
          <NightColumn key={n.date} night={n} auto={autoDates.has(n.date)} disabled={p.busy || s.busy} onOpen={() => setEditing(n.date)} />
        ))}
      </div>

      {s.view.groceries && (
        <div className="wpm-gro">
          <span className="wpm-gro-i" aria-hidden>🛒</span>
          <div className="wpm-gro-m">
            <b>Groceries</b>
            <span className="wpm-gro-s">
              {s.groceryAdded !== null
                ? `${s.groceryAdded} items added · staples skipped`
                : "built from what's planned so far · staples skipped"}
            </span>
          </div>
          <span className="wpm-gro-pill">
            {s.view.groceries.items} items · aisle order
            {s.view.groceries.checked > 0 ? ` · ${s.view.groceries.checked} ticked` : ''}
          </span>
          {/* The trip is a REAL one-off chore on the Tasks board; with the chores module off
              there is nowhere for it to live, so the control goes away rather than sit dead. */}
          {s.view.choresOn && (
            <button
              type="button"
              className={`wpm-gro-pill wpm-shop${s.view.shopping ? '' : ' open'}`}
              disabled={p.busy || s.busy}
              onClick={() => setShopping(true)}
            >
              {tripLabel(s.view.shopping)}
            </button>
          )}
        </div>
      )}

      {shopping && s.view.choresOn && (
        <ShopperModal
          weekStart={p.weekStart}
          nights={s.view.nights}
          trip={s.view.shopping}
          people={s.people}
          busy={s.busy}
          onClose={() => setShopping(false)}
          onSave={(t) => { setShopping(false); void setShopper(p.weekStart, t, p.refresh) }}
        />
      )}

      {s.kept.length > 0 && (
        <div className="wpm-note">
          {countWord(s.kept.length)} {s.kept.length === 1 ? 'night was' : 'nights were'} left alone — {s.kept.map(dow).join(', ')}{' '}
          {s.kept.length === 1 ? 'has' : 'have'} been decided since.
        </div>
      )}
      {s.error && <div className="wpm-note wpm-note-bad">{s.error}</div>}

      {s.planner && (
        <div className="wpm-planner" role="dialog" aria-label="Plan the rest of the week">
          <div className="wpm-planner-head">
            <button type="button" className="pill wpm-planner-back" onClick={() => set({ planner: false })}>
              ‹ Back to the week
            </button>
            <span className="wpm-planner-n">
              Planning the {countWord(emptyDays.length)} empty {emptyDays.length === 1 ? 'night' : 'nights'} — the rest stay as they are
            </span>
          </div>
          <PlanWeek
            startStr={p.weekStart}
            days={emptyDays}
            initialDays={s.view.emptyDates}
            mealTypes={['dinner']}
            onClose={() => set({ planner: false })}
            onApplied={() => {}}
            onApply={(cards) => applyPlan(p.weekStart, cards, p.refresh)}
          />
        </div>
      )}

      {/* Never both: the two overlays are the same surface. */}
      {night && !s.planner && (
        <NightPicker
          // Keyed by the night so switching nights starts on a fresh search.
          key={night.date}
          night={night}
          onClose={() => setEditing(null)}
          // Close FIRST, write second: `planNight` refuses to run while another write is in
          // flight, and a picker still on screen invites exactly that second tap.
          onPick={(slot) => { setEditing(null); void planNight(p.weekStart, night.date, slot, p.refresh) }}
          onPickMeal={(meal) => { setEditing(null); void planPlate(p.weekStart, night.date, meal.id, p.refresh) }}
          onClear={() => { setEditing(null); void clearNight(p.weekStart, night.date, p.refresh) }}
        />
      )}
    </div>
  )
}

// Four states, each legible at a glance across seven columns: planned, empty, auto-filled,
// eating out. `isEatingOut` is the classifier the Meals screen already uses on recipe-less
// placeholder rows — the same night must not read differently on the two screens.
function NightColumn({ night, auto, disabled, onOpen }: {
  night: PlanningMealsNight
  auto: boolean
  disabled: boolean
  onOpen: () => void
}) {
  const d = night.dinner
  // A PLATE IS NEVER TAKEOUT. `isEatingOut` reads a recipe-less row's title, and a plate is
  // recipe-less with the plate's NAME as its title — so a plate called "Takeout Tuesday"
  // would otherwise claim "no cooking". `!recipeId && mealId` is MealsColumn's plate branch.
  const out = !!d && !d.mealId && isEatingOut({ recipeId: d.recipeId, title: d.title })
  const cls = d ? (auto ? ' auto' : out ? ' out' : '') : ' empty'
  const attrib = d ? attribution(d, auto, out) : null
  return (
    <div className="wpm-night">
      <div className="wpm-night-h">
        <b>{dow(night.date)}</b>
        <span>{dayNum(night.date)}</span>
      </div>

      <ul className="wpm-events">
        {night.events.map((e) => (
          <li key={e.id} className="wpm-ev">
            <i className="wpm-ev-dot" style={e.personColor ? { background: e.personColor } : undefined} aria-hidden />
            <span className="wpm-ev-t">{e.title}</span>
            <span className="wpm-ev-c">{clock(e)}</span>
          </li>
        ))}
        {!night.events.length && <li className="wpm-ev wpm-ev-none">Nothing on</li>}
      </ul>

      <button
        type="button"
        className={`wpm-dish${cls}`}
        disabled={disabled}
        onClick={onOpen}
        aria-label={d ? `${d.title} on ${dow(night.date)} — change it` : `Plan ${dow(night.date)}`}
      >
        {d ? (
          <>
            <span className="wpm-dish-e" aria-hidden>{d.emoji ?? (out ? '🥡' : '🍽️')}</span>
            <span className="wpm-dish-t">{d.title}</span>
            {attrib && <span className="wpm-dish-c">{attrib}</span>}
            {auto && <span className="wpm-auto">✨ auto</span>}
          </>
        ) : (
          <>
            <span className="wpm-dish-plus" aria-hidden>+</span>
            <span className="wpm-dish-t">Nothing planned</span>
          </>
        )}
      </button>
    </div>
  )
}

// The library must keep coming through `useRecipes` and must NOT be cached in this file's
// module state behind `if (recipes) return`: an EMPTY library is a truthy `[]`, so a household
// that opened the picker before adding its first recipe would be told "no recipes yet" for the
// rest of the page's life.
function NightPicker({ night, onClose, onPick, onPickMeal, onClear }: {
  night: PlanningMealsNight
  onClose: () => void
  onPick: (slot: { recipeId?: string | null; title?: string | null }) => void
  onPickMeal: (meal: Meal) => void
  onClear: () => void
}) {
  const { recipes, loading, error } = useRecipes()

  return (
    <div className="wpm-picker" role="dialog" aria-label={`Plan ${dow(night.date)} dinner`}>
      <div className="wpm-picker-head">
        <button type="button" className="pill wpm-planner-back" onClick={onClose}>‹ Back to the week</button>
        <span className="wpm-picker-t wf-serif">{dow(night.date)} dinner · {dayNum(night.date)}</span>
        <span className="wpm-picker-n">
          {error
            ? "Couldn't read your recipes — reload and try again."
            : night.dinner
              ? `Currently ${night.dinner.title}`
              : 'Nothing planned yet'}
        </span>
        {night.dinner && (
          <button type="button" className="btn btn-ghost wpm-picker-clear" onClick={onClear}>Clear this night</button>
        )}
      </div>
      <RecipeBrowser
        recipes={recipes}
        loading={loading}
        slot="dinner"
        onPick={(r) => onPick({ recipeId: r.id, title: null })}
        // Plates only appear when a caller can say WHERE one goes — the date lives in this
        // closure, never in the browser.
        onPickMeal={onPickMeal}
        // The same three literals the Meals screen writes, so the classifiers agree.
        onEatingOut={() => onPick({ title: 'Eating out', recipeId: null })}
        onLeftovers={() => onPick({ title: 'Leftovers', recipeId: null })}
        onTrySomething={() => onPick({ title: 'Try something new', recipeId: null })}
        // KEPT, and only this: the three cards and "＋ New recipe" don't cover the one-off
        // named dish nobody wants to write a recipe for. It rides the browser's search box.
        onFreeText={(text) => onPick({ title: text, recipeId: null })}
        selectLabel={`Plan for ${dow(night.date)}`}
      />
    </div>
  )
}

function ShopperModal({ weekStart, nights, trip, people, busy, onClose, onSave }: {
  weekStart: string
  nights: PlanningMealsNight[]
  trip: PlanningShoppingTrip | null
  people: Person[] | null
  busy: boolean
  onClose: () => void
  onSave: (t: { dueOn: string | null; personId: string | null; dueTime: string | null }) => void
}) {
  const [personId, setPersonId] = useState<string | null>(trip?.personId ?? null)
  const [dueOn, setDueOn] = useState<string>(trip?.dueOn ?? nights[nights.length - 1]?.date ?? weekStart)
  const [dueTime, setDueTime] = useState<string>(trip?.dueTime ?? '')

  useEffect(() => {
    if (people) return
    let alive = true
    personsApi.persons().then((r) => { if (alive) set({ people: r.persons }) }).catch(() => { if (alive) set({ people: [] }) })
    return () => { alive = false }
  }, [people])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card wpm-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="wpm-modal-t wf-serif">The shopping trip</div>
        <div className="wpm-modal-s">
          It lands on the Tasks board as a real assignment — leaving it up for grabs is a real answer.
        </div>

        <div className="wpm-modal-h">Who's going</div>
        <div className="wpm-picks">
          <button
            type="button"
            className={`wpm-pick${personId === null ? ' on' : ''}`}
            onClick={() => setPersonId(null)}
          >
            Up for grabs
          </button>
          {people === null && <div className="wpm-msg">Loading…</div>}
          {people?.map((pp) => (
            <button
              key={pp.id}
              type="button"
              className={`wpm-pick${personId === pp.id ? ' on' : ''}`}
              onClick={() => setPersonId(pp.id)}
            >
              <span aria-hidden>{pp.avatarEmoji ?? '\u{1F464}'}</span> {pp.name}
            </button>
          ))}
        </div>

        <div className="wpm-modal-h">Which day</div>
        <div className="wpm-picks">
          {nights.map((n) => (
            <button
              key={n.date}
              type="button"
              className={`wpm-pick${dueOn === n.date ? ' on' : ''}`}
              onClick={() => setDueOn(n.date)}
            >
              {dow(n.date)}
            </button>
          ))}
        </div>

        <label className="field">
          <span>What time (optional)</span>
          <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
        </label>

        <div className="wpm-modal-f">
          {trip && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSave({ dueOn: null, personId: null, dueTime: null })}>
              No trip this week
            </button>
          )}
          <div className="wpm-modal-sp" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn btn-primary" disabled={busy}
            onClick={() => onSave({ dueOn, personId, dueTime: dueTime || null })}
          >
            {trip ? 'Update the trip' : 'Add it to Tasks'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── FooterExtra ──────────────────────────────────────────────────────────────────

function FooterExtra(p: StepBodyProps) {
  const s = useMealsStep(p)
  if (!s.view) return null
  const disabled = p.busy || s.busy

  if (s.filled.length) {
    return (
      <button type="button" className="btn btn-ghost wpm-act" disabled={disabled} onClick={() => void runUndo(p.weekStart, p.refresh)}>
        Undo the {countWord(s.filled.length)}
      </button>
    )
  }

  const empties = s.view.emptyDates.length
  return (
    <button
      type="button"
      className="btn btn-ai wpm-act"
      disabled={disabled || !empties}
      title={empties ? `Fills the ${countWord(empties)} empty ${empties === 1 ? 'night' : 'nights'}` : 'Every night is planned'}
      onClick={() => set({ planner: true })}
    >
      <span aria-hidden>✨</span> Plan the rest for me
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
