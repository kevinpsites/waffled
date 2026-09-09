import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { MultiSelect } from './components/MultiSelect'
import { MealCard } from './components/MealCard'
import { useRecipes, useRecentRecipes, useSavedMeals, type Recipe } from '../lib/api'
import './../styles/recipe.css'

const GRAD_BY_CATEGORY: Record<string, string> = {
  breakfast: 'g-pan',
  lunch: 'g-veg',
  dinner: 'g-pasta',
  snack: 'g-cookie',
  dessert: 'g-cookie',
}
function gradClass(r: Recipe): string {
  return (r.category && GRAD_BY_CATEGORY[r.category.toLowerCase()]) || 'g-veg'
}

function haystack(r: Recipe): string {
  return [r.title, r.cuisine, r.protein, r.base, r.mealType, r.effort, r.cookMethod, r.collection, ...(r.tags ?? []), ...r.vegetables, ...r.dietary]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function distinct(recipes: Recipe[], key: keyof Recipe): string[] {
  const s = new Set<string>()
  for (const r of recipes) {
    const v = r[key]
    if (typeof v === 'string' && v) s.add(v)
  }
  return [...s].sort()
}

const SORTS: Array<{ key: string; label: string }> = [
  { key: 'name', label: 'A–Z' },
  { key: 'time', label: 'Quickest' },
  { key: 'cooked', label: 'Most cooked' },
  { key: 'recent', label: 'Recently cooked' },
]

// The library is a unified list: recipes AND saved meals. Recipes are already loaded
// client-side and filtered here; saved meals are searched SERVER-side (`GET /api/meals?q=`,
// which matches the plate name OR any dish title). Never re-filter the returned meals
// against the plate name — that throws away exactly the matches the server found.
export function RecipesLibrary() {
  const navigate = useNavigate()
  const { recipes, loading, error } = useRecipes()
  const recent = useRecentRecipes()
  const [params] = useSearchParams()
  const initArr = (k: string) => params.get(k)?.split(',').filter(Boolean) ?? []

  const [q, setQ] = useState(() => params.get('q') ?? '')
  const [fav, setFav] = useState(false)
  const [newOnly, setNewOnly] = useState(() => params.get('new') === '1')
  const [collections, setCollections] = useState<string[]>(() => initArr('collection'))
  const [cuisines, setCuisines] = useState<string[]>(() => initArr('cuisine'))
  const [proteins, setProteins] = useState<string[]>(() => initArr('protein'))
  const [diets, setDiets] = useState<string[]>(() => initArr('diet'))
  const [sort, setSort] = useState('name')
  // A TYPE filter, not a structured one: it selects saved plates rather than narrowing
  // recipe metadata, so lumping it in with fav/cuisine/protein would filter itself out.
  const [mealsOnly, setMealsOnly] = useState(() => params.get('type') === 'meal')

  // Debounced: the recipe list is in memory, but the saved-meal search is a round trip.
  const [mealQ, setMealQ] = useState(() => (params.get('q') ?? '').trim())
  useEffect(() => {
    const t = setTimeout(() => setMealQ(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])
  const { meals: savedMeals, loading: mealsLoading } = useSavedMeals(mealQ || undefined)

  const collOpts = useMemo(() => distinct(recipes, 'collection'), [recipes])
  const cuisineOpts = useMemo(() => distinct(recipes, 'cuisine'), [recipes])
  const proteinOpts = useMemo(() => distinct(recipes, 'protein'), [recipes])
  const dietOpts = useMemo(() => {
    const s = new Set<string>()
    recipes.forEach((r) => r.dietary.forEach((d) => s.add(d)))
    return [...s].sort()
  }, [recipes])

  const ql = q.trim().toLowerCase()
  const has = (arr: string[], v: string | null) => arr.length === 0 || (v != null && arr.includes(v))
  const filtered = recipes.filter(
    (r) =>
      (!fav || r.isFavorite) &&
      (!newOnly || r.cookedCount === 0) &&
      has(collections, r.collection) &&
      has(cuisines, r.cuisine) &&
      has(proteins, r.protein) &&
      (diets.length === 0 || diets.some((d) => r.dietary.includes(d))) &&
      (!ql || haystack(r).includes(ql))
  )

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'time') return (a.cookTimeMinutes ?? 1e9) - (b.cookTimeMinutes ?? 1e9)
    if (sort === 'cooked') return b.cookedCount - a.cookedCount
    if (sort === 'recent') return (b.lastCookedAt ?? '').localeCompare(a.lastCookedAt ?? '')
    return a.title.localeCompare(b.title)
  })

  // The structured filters are recipe metadata a plate doesn't carry, so with any of them
  // on this is a recipe list. Free-text search, by contrast, spans both.
  const structuredFilter = fav || newOnly || collections.length > 0 || cuisines.length > 0 || proteins.length > 0 || diets.length > 0
  const mealList = savedMeals ?? []
  const shownMeals = structuredFilter ? [] : [...mealList].sort((a, b) => a.name.localeCompare(b.name))
  // "Meals" HIDES the recipes rather than narrowing them — the counts still read against
  // the whole library, so "1 of 2" tells you what you're not seeing.
  const shownRecipes = mealsOnly ? [] : sorted
  const shownCount = shownRecipes.length + shownMeals.length
  const totalCount = recipes.length + mealList.length

  const anyFilter = structuredFilter || mealsOnly || ql
  function clearAll() {
    setFav(false); setNewOnly(false); setCollections([]); setCuisines([]); setProteins([]); setDiets([]); setQ(''); setMealsOnly(false)
  }

  // THE LIBRARY IS GENUINELY EMPTY — not merely "nothing is showing". A search with no hits
  // also shows nothing, and hiding the search box there would strand somebody with a query
  // they can no longer clear. So this needs both sources loaded, both empty, and nothing
  // typed or toggled.
  const libraryEmpty = !loading && !error && !mealsLoading && recipes.length === 0 && mealList.length === 0 && !anyFilter

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals')}>‹ Meals</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600 }}>Recipes</div>
        {/* The only in-app way to start an empty plate. Deliberately the bare route
            with no id: the builder creates the meal lazily on the first dish, so
            abandoning this screen leaves no orphan behind. */}
        <button className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => navigate('/meals/build')}>＋ New meal</button>
        {/* ONE primary on the screen. With an empty library the whole page is a call
            to add the first recipe, so the header's copy of that button would be the
            second — which is what made the old empty state read as a mistake. */}
        {!libraryEmpty && (
          <button className="pill btn-primary" style={{ color: 'var(--on-accent)', border: 0, cursor: 'pointer' }} onClick={() => navigate('/meals/recipe/new')}>＋ New recipe</button>
        )}
      </div>
    ),
    [navigate, libraryEmpty]
  )

  if (libraryEmpty) {
    return (
      <div className="recipes-lib">
        {/* No count, no sort, no filters: with nothing to count or narrow they are
            controls that cannot do their job. One thing to say, one thing to do. */}
        <div className="recipes-empty">
          <div className="recipes-empty-e" aria-hidden>🍳</div>
          <div className="recipes-empty-t wf-serif">No recipes yet</div>
          <div className="recipes-empty-s">
            Add your first and it turns up everywhere it&apos;s useful — the meal planner, the
            grocery list, Cook Mode.
          </div>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/meals/recipe/new')}>
            ＋ New recipe
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="recipes-lib">
      <div className="recipes-head">
        <input className="recipes-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes & meals, cuisine, protein, a veggie…" aria-label="Search recipes and meals" />
        <select className="recipes-filter recipes-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>Sort: {s.label}</option>
          ))}
        </select>
        <button type="button" className={`pill ${fav ? 'btn-primary' : ''}`} style={{ cursor: 'pointer', color: fav ? 'var(--on-accent)' : undefined, border: fav ? 0 : undefined }} onClick={() => setFav((v) => !v)}>
          {fav ? '❤️' : '🤍'} Favorites
        </button>
        <button type="button" className={`pill ${newOnly ? 'btn-primary' : ''}`} style={{ cursor: 'pointer', color: newOnly ? 'var(--on-accent)' : undefined, border: newOnly ? 0 : undefined }} onClick={() => setNewOnly((v) => !v)}>
          🆕 New
        </button>
        {/* Sits with Favorites/New because it is the same kind of control — a
            one-tap view of the library, not a metadata narrowing. */}
        <button type="button" className={`pill ${mealsOnly ? 'btn-primary' : ''}`} style={{ cursor: 'pointer', color: mealsOnly ? 'var(--on-accent)' : undefined, border: mealsOnly ? 0 : undefined }} aria-pressed={mealsOnly} aria-label="Show only meals" onClick={() => setMealsOnly((v) => !v)}>
          🍽️ Meals
        </button>
      </div>

      <div className="recipes-filters">
        <MultiSelect label="Collection" options={collOpts} selected={collections} onChange={setCollections} />
        <MultiSelect label="Cuisine" options={cuisineOpts} selected={cuisines} onChange={setCuisines} />
        <MultiSelect label="Protein" options={proteinOpts} selected={proteins} onChange={setProteins} />
        <MultiSelect label="Dietary" options={dietOpts} selected={diets} onChange={setDiets} />
        <span className="tiny muted recipes-count">{shownCount} of {totalCount}</span>
        {anyFilter ? <button type="button" className="pill recipes-clear" onClick={clearAll}>Clear</button> : null}
      </div>

      {/* A shortcut back to what you just had open, above the library proper. Hidden
          entirely with no history — an empty strip under a heading is worse than
          nothing. Never filtered by the controls above: it's a shortcut, not a
          second view of the list. */}
      {recent.recipes.length > 0 && (
        <div className="recents" data-testid="recent-recipes">
          <div className="recents-h">
            <span className="recents-title">Recently viewed</span>
            <div className="recents-scope">
              <button
                type="button"
                className={`pill ${recent.scope === 'me' ? 'on' : ''}`}
                onClick={() => recent.setScope('me')}
              >
                Me
              </button>
              <button
                type="button"
                className={`pill ${recent.scope === 'household' ? 'on' : ''}`}
                onClick={() => recent.setScope('household')}
              >
                Everyone
              </button>
            </div>
          </div>
          <div className="recents-row">
            {recent.recipes.map((r) => (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                className="recents-card"
                onClick={() => navigate(`/meals/recipe/${r.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/meals/recipe/${r.id}`) } }}
              >
                <div className={`recents-img ${gradClass(r)}`}>
                  {r.imageUrl ? <img className="rc-img-photo" src={r.imageUrl} alt="" /> : (r.emoji ?? '🍽️')}
                </div>
                <div className="recents-t">{r.title}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div className="muted" style={{ padding: 20 }}>Couldn't load recipes — try reloading or signing in again.</div>}
      {/* The empty LIBRARY is handled above, as its own screen. What is left here is
          the empty RESULT — the search and filters are still on show, so the way out
          is the Clear beside them rather than a second primary jammed mid-sentence. */}
      {!error && !loading && shownCount === 0 && (
        <div className="muted" style={{ padding: 20, fontWeight: 600 }}>Nothing matches these filters.</div>
      )}

      <div className="recipes-grid">
        {/* Saved meals lead the grid — a plate is a bigger idea than one dish, and
            leading with them keeps the badge visible instead of buried. */}
        {shownMeals.map((m) => (
          <MealCard key={m.id} meal={m} className="recipes-card" onOpen={() => navigate(`/meals/build/${m.id}`)} />
        ))}
        {shownRecipes.map((r) => (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            className="rc recipes-card"
            onClick={() => navigate(`/meals/recipe/${r.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/meals/recipe/${r.id}`) } }}
          >
            <div className={`rc-img ${gradClass(r)}`}>
              {r.imageUrl ? <img className="rc-img-photo" src={r.imageUrl} alt={r.title} /> : (r.emoji ?? '🍽️')}
              {r.isFavorite && <span className="recipes-fav">❤️</span>}
              {r.cookedCount === 0 && <span className="recipes-new" title="Never cooked" style={{ position: 'absolute', top: 8, left: 10, fontSize: 16 }}>🆕</span>}
            </div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>{r.title}</div>
              <div className="rc-m">
                {r.cuisine && <span>🌍 {r.cuisine}</span>}
                {r.protein && <span>🥩 {r.protein}</span>}
                {r.cookTimeMinutes != null && <span>🕐 {r.cookTimeMinutes}m</span>}
                {r.cookedCount > 0 && <span>👨‍🍳 {r.cookedCount}×</span>}
              </div>
              {r.collection && <div className="recipes-coll">📁 {r.collection}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
