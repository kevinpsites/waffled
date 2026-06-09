import { AgendaCard } from './components/AgendaCard'
import { MealsColumn } from './components/MealsColumn'
import { FamilyColumn } from './components/FamilyColumn'

// The kiosk "Today" dashboard: agenda · meals · family chores + grocery.
export function Today() {
  return (
    <div className="today-grid">
      <AgendaCard />
      <MealsColumn />
      <FamilyColumn />
    </div>
  )
}
