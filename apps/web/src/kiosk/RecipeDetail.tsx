import { useParams } from 'react-router'
import { RecipeView } from './components/RecipeView'

// Full-screen recipe route: the shared RecipeView renders its own topbar row
// (back button + favorite/edit/schedule icons) when `fullScreen` is set. The
// modal preview uses the same view with the actions inline instead.
export function RecipeDetail() {
  const { id } = useParams()
  if (!id) return <div className="muted" style={{ padding: 30 }}>Recipe not found.</div>
  return <RecipeView id={id} fullScreen />
}
