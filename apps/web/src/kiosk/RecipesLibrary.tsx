import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTopbarFull } from './topbar-slot'
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

function distinct(recipes: Recipe[], key: keyof Recipe): string[] {
  const s = new Set<string>()
  for (const r of recipes) {
    const v = r[key]
    if (typeof v === 'string' && v) s.add(v)
  }
  return [...s].sort()
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  if (options.length === 0) return null
  return (
    <select className={`recipes-filter ${value ? 'on' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  )
}

export function RecipesLibrary() {
  const navigate = useNavigate()
  const { recipes, loading, error } = useRecipes()
  const [q, setQ] = useState('')
  const [fav, setFav] = useState(false)
  const [collection, setCollection] = useState('')
  const [cuisine, setCuisine] = useState('')
  const [protein, setProtein] = useState('')
  const [diet, setDiet] = useState('')

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals')}>‹ Meals</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600 }}>Recipes</div>
      </div>
    ),
    [navigate]
  )

  const collections = useMemo(() => distinct(recipes, 'collection'), [recipes])
  const cuisines = useMemo(() => distinct(recipes, 'cuisine'), [recipes])
  const proteins = useMemo(() => distinct(recipes, 'protein'), [recipes])
  const diets = useMemo(() => {
    const s = new Set<string>()
    recipes.forEach((r) => r.dietary.forEach((d) => s.add(d)))
    return [...s].sort()
  }, [recipes])

  const ql = q.trim().toLowerCase()
  const filtered = recipes.filter(
    (r) =>
      (!fav || r.isFavorite) &&
      (!collection || r.collection === collection) &&
      (!cuisine || r.cuisine === cuisine) &&
      (!protein || r.protein === protein) &&
      (!diet || r.dietary.includes(diet)) &&
      (!ql ||
        r.title.toLowerCase().includes(ql) ||
        (r.tags ?? []).some((t) => t.toLowerCase().includes(ql)) ||
        (r.cuisine ?? '').toLowerCase().includes(ql) ||
        (r.protein ?? '').toLowerCase().includes(ql))
  )

  const anyFilter = fav || collection || cuisine || protein || diet || ql
  function clearAll() {
    setFav(false); setCollection(''); setCuisine(''); setProtein(''); setDiet(''); setQ('')
  }

  return (
    <div className="recipes-lib">
      <div className="recipes-head">
        <input className="recipes-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes, cuisine, protein…" aria-label="Search recipes" />
        <button type="button" className={`pill ${fav ? 'btn-primary' : ''}`} style={{ marginLeft: 'auto', cursor: 'pointer', color: fav ? '#fff' : undefined, border: fav ? 0 : undefined }} onClick={() => setFav((v) => !v)}>
          {fav ? '❤️' : '🤍'} Favorites
        </button>
      </div>

      <div className="recipes-filters">
        <FilterSelect label="Collection" value={collection} options={collections} onChange={setCollection} />
        <FilterSelect label="Cuisine" value={cuisine} options={cuisines} onChange={setCuisine} />
        <FilterSelect label="Protein" value={protein} options={proteins} onChange={setProtein} />
        <FilterSelect label="Dietary" value={diet} options={diets} onChange={setDiet} />
        <span className="tiny muted recipes-count">{filtered.length} of {recipes.length}</span>
        {anyFilter && <button type="button" className="pill recipes-clear" onClick={clearAll}>Clear</button>}
      </div>

      {error && <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see recipes.</div>}
      {!error && !loading && filtered.length === 0 && (
        <div className="muted" style={{ padding: 20, fontWeight: 600 }}>
          {recipes.length === 0 ? 'No recipes yet — import some with `just import-recipes`.' : 'No recipes match these filters.'}
        </div>
      )}

      <div className="recipes-grid">
        {filtered.map((r) => (
          <button key={r.id} type="button" className="rc recipes-card" onClick={() => navigate(`/meals/recipe/${r.id}`)}>
            <div className={`rc-img ${gradClass(r)}`}>
              {r.emoji ?? '🍽️'}
              {r.isFavorite && <span className="recipes-fav">❤️</span>}
            </div>
            <div className="rc-b" style={{ padding: '12px 14px 14px' }}>
              <div className="rc-t" style={{ fontSize: 16 }}>{r.title}</div>
              <div className="rc-m">
                {r.cuisine && <span>🌍 {r.cuisine}</span>}
                {r.protein && <span>🥩 {r.protein}</span>}
                {r.cookTimeMinutes != null && <span>🕐 {r.cookTimeMinutes}m</span>}
              </div>
              {r.collection && <div className="recipes-coll">📁 {r.collection}</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
