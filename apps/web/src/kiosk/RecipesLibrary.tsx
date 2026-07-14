import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { MultiSelect } from './components/MultiSelect'
import { useRecipes, type Recipe } from '../lib/api'
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

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals')}>‹ Meals</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600 }}>Recipes</div>
        <button className="pill btn-primary" style={{ marginLeft: 'auto', color: 'var(--on-accent)', border: 0, cursor: 'pointer' }} onClick={() => navigate('/meals/recipe/new')}>＋ New recipe</button>
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

  const anyFilter = fav || newOnly || collections.length || cuisines.length || proteins.length || diets.length || ql
  function clearAll() {
    setFav(false); setNewOnly(false); setCollections([]); setCuisines([]); setProteins([]); setDiets([]); setQ('')
  }

  return (
    <div className="recipes-lib">
      <div className="recipes-head">
        <input className="recipes-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes, cuisine, protein, a veggie…" aria-label="Search recipes" />
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
      </div>

      <div className="recipes-filters">
        <MultiSelect label="Collection" options={collOpts} selected={collections} onChange={setCollections} />
        <MultiSelect label="Cuisine" options={cuisineOpts} selected={cuisines} onChange={setCuisines} />
        <MultiSelect label="Protein" options={proteinOpts} selected={proteins} onChange={setProteins} />
        <MultiSelect label="Dietary" options={dietOpts} selected={diets} onChange={setDiets} />
        <span className="tiny muted recipes-count">{sorted.length} of {recipes.length}</span>
        {anyFilter ? <button type="button" className="pill recipes-clear" onClick={clearAll}>Clear</button> : null}
      </div>

      {error && <div className="muted" style={{ padding: 20 }}>Couldn't load recipes — try reloading or signing in again.</div>}
      {!error && !loading && sorted.length === 0 && (
        <div className="muted" style={{ padding: 20, fontWeight: 600 }}>
          {recipes.length === 0 ? (
            <>No recipes yet — tap <button type="button" className="pill btn-primary" style={{ color: 'var(--on-accent)', border: 0, cursor: 'pointer' }} onClick={() => navigate('/meals/recipe/new')}>＋ New recipe</button> to add your first.</>
          ) : 'No recipes match these filters.'}
        </div>
      )}

      <div className="recipes-grid">
        {sorted.map((r) => (
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
