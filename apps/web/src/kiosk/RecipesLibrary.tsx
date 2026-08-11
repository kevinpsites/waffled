import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { MultiSelect } from './components/MultiSelect'
import { MealCard } from './components/MealCard'
import { useRecipes, useSavedMeals, type Recipe } from '../lib/api'
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

// Title + every metadata field, so search matches cuisine / protein / a vegetable
// ("cucumber") / a tag / effort, etc.
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

// The library is a unified list: recipes AND saved meals (decision 11). The two
// come from different endpoints — recipes are already loaded client-side and
// filtered here, while saved meals are searched *server-side* (`GET /api/meals?q=`,
// which matches the plate name OR any of its dish titles, so "chicken" finds
// "BBQ Sunday"). Never re-filter the returned meals against the plate name — that
// would throw away exactly the matches the server worked to find.
export function RecipesLibrary() {
  const navigate = useNavigate()
  const { recipes, loading, error } = useRecipes()
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
  // A TYPE filter, not a structured one: it selects saved plates rather than
  // narrowing recipe metadata. Lumping it in with fav/cuisine/protein (which all
  // drop meals, since a plate has none of that) would make it filter itself out.
  const [mealsOnly, setMealsOnly] = useState(() => params.get('type') === 'meal')

  // Debounced so a search doesn't fire a request per keystroke — the recipe list is
  // already in memory, but the saved-meal search is a round trip.
  const [mealQ, setMealQ] = useState(() => (params.get('q') ?? '').trim())
  useEffect(() => {
    const t = setTimeout(() => setMealQ(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])
  const { meals: savedMeals } = useSavedMeals(mealQ || undefined)

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals')}>‹ Meals</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600 }}>Recipes</div>
        {/* The only in-app way to start an empty plate. Deliberately the bare route
            with no id: the builder creates the meal lazily on the first dish, so
            abandoning this screen leaves no orphan behind. */}
        <button className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => navigate('/meals/build')}>＋ New meal</button>
        <button className="pill btn-primary" style={{ color: 'var(--on-accent)', border: 0, cursor: 'pointer' }} onClick={() => navigate('/meals/recipe/new')}>＋ New recipe</button>
      </div>
    ),
    [navigate]
  )

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

  // The structured filters (favorite / never-cooked / collection / cuisine / protein /
  // dietary) are recipe metadata a plate doesn't carry, so a meal can be neither
  // included nor excluded by them honestly — with any of them on, this is a recipe
  // list. Free-text search, by contrast, spans both.
  const structuredFilter = fav || newOnly || collections.length > 0 || cuisines.length > 0 || proteins.length > 0 || diets.length > 0
  const mealList = savedMeals ?? []
  const shownMeals = structuredFilter ? [] : [...mealList].sort((a, b) => a.name.localeCompare(b.name))
  // "Meals" hides the recipes instead of narrowing them — the counts still read
  // against the whole library, so "1 of 2" tells you what you're not seeing.
  const shownRecipes = mealsOnly ? [] : sorted
  const shownCount = shownRecipes.length + shownMeals.length
  const totalCount = recipes.length + mealList.length

  const anyFilter = structuredFilter || mealsOnly || ql
  function clearAll() {
    setFav(false); setNewOnly(false); setCollections([]); setCuisines([]); setProteins([]); setDiets([]); setQ(''); setMealsOnly(false)
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

      {error && <div className="muted" style={{ padding: 20 }}>Couldn't load recipes — try reloading or signing in again.</div>}
      {!error && !loading && shownCount === 0 && (
        <div className="muted" style={{ padding: 20, fontWeight: 600 }}>
          {totalCount === 0 ? (
            <>No recipes yet — tap <button type="button" className="pill btn-primary" style={{ color: 'var(--on-accent)', border: 0, cursor: 'pointer' }} onClick={() => navigate('/meals/recipe/new')}>＋ New recipe</button> to add your first.</>
          ) : 'Nothing matches these filters.'}
        </div>
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
