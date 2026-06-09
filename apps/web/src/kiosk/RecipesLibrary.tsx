import { useState } from 'react'
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

export function RecipesLibrary() {
  const navigate = useNavigate()
  const { recipes, loading, error } = useRecipes()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/meals')}>‹ Meals</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600 }}>Recipes</div>
      </div>
    ),
    [navigate]
  )

  const filtered = recipes.filter(
    (r) => (filter === 'all' || r.isFavorite) && r.title.toLowerCase().includes(q.trim().toLowerCase())
  )

  return (
    <div className="recipes-lib">
      <div className="recipes-head">
        <input className="recipes-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes…" aria-label="Search recipes" />
        <div className="seg" style={{ marginLeft: 'auto' }}>
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'favorites' ? 'on' : ''} onClick={() => setFilter('favorites')}>♥ Favorites</button>
        </div>
      </div>

      {error && <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see recipes.</div>}
      {!error && !loading && filtered.length === 0 && (
        <div className="muted" style={{ padding: 20, fontWeight: 600 }}>
          {recipes.length === 0 ? 'No recipes yet — import some with `just import-recipes`.' : 'No recipes match.'}
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
                {r.cookTimeMinutes != null && <span>🕐 {r.cookTimeMinutes} min</span>}
                {r.category && <span>{r.category}</span>}
                {r.cookedCount > 0 && <span>cooked {r.cookedCount}×</span>}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
