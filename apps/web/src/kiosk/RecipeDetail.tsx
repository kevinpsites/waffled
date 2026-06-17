import { useParams, useNavigate } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { RecipeView } from './components/RecipeView'

// Full-screen recipe route: just the back-button chrome around the shared
// RecipeView (the same view used in the modal preview everywhere else).
export function RecipeDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  useTopbarFull(() => <button className="pill" onClick={() => navigate(-1)}>‹ Recipes</button>, [navigate])
  if (!id) return <div className="muted" style={{ padding: 30 }}>Recipe not found.</div>
  return <RecipeView id={id} />
}
