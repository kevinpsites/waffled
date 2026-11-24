// Kiosk cook view for a Mealie recipe: big type, ingredients beside numbered steps.
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { mealieApi, useMealieQuery } from '../lib/api/mealie'
import { MealieError } from './components/MealieError'
import { MealiePlanModal } from './components/MealiePlanModal'

export function MealieRecipe() {
  const { slug = '' } = useParams()
  const { data, error, retry } = useMealieQuery(() => mealieApi.recipe(slug), [slug])
  const [planning, setPlanning] = useState(false)
  const r = data?.recipe
  return (
    <div className="mealie-cook">
      <Link to="/meals" className="tiny muted" style={{ textDecoration: 'none' }}>‹ Meals</Link>
      {error != null && <MealieError error={error} onRetry={retry} />}
      {!error && !r && <div className="muted" style={{ padding: 16 }}>Loading…</div>}
      {!error && r && (
        <>
          <div className="mealie-cook-head">
            {r.imageUrl && <img src={r.imageUrl} alt="" className="mealie-cook-img" />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 className="wf-serif" style={{ fontSize: 34, margin: '0 0 6px' }}>{r.name}</h1>
              <div className="muted" style={{ marginBottom: 10 }}>
                {[r.totalTime, r.recipeYield && `Serves ${r.recipeYield}`].filter(Boolean).join(' · ')}
              </div>
              {r.description && <p style={{ margin: '0 0 12px' }}>{r.description}</p>}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={() => setPlanning(true)}>Plan this</button>
                <a className="btn btn-ghost" href={r.mealieUrl} target="_blank" rel="noopener noreferrer">Open in Mealie</a>
              </div>
            </div>
          </div>
          <div className="mealie-cook-body">
            <section>
              <h2 className="wf-serif">Ingredients</h2>
              {r.ingredients.map((ing, i) => (
                <div key={i}>
                  {ing.title && <h3 className="mealie-cook-sub">{ing.title}</h3>}
                  <div className="mealie-cook-ing">{ing.display}</div>
                </div>
              ))}
            </section>
            <section>
              <h2 className="wf-serif">Steps</h2>
              <ol className="mealie-steps">
                {r.steps.map((s, i) => (
                  <li key={i}>
                    {s.title && <strong>{s.title}. </strong>}
                    {s.text}
                  </li>
                ))}
              </ol>
            </section>
          </div>
          {planning && <MealiePlanModal recipe={{ id: r.id, name: r.name }} onClose={() => setPlanning(false)} />}
        </>
      )}
    </div>
  )
}
