import { AgendaCard } from './components/AgendaCard'
import { MealsColumn } from './components/MealsColumn'
import { FamilyColumn } from './components/FamilyColumn'
import { GoalRecapBar } from './components/GoalRecap'

// The kiosk "Today" dashboard: agenda · meals · family chores + grocery. When a
// linked calendar event has ended and is waiting to be confirmed, a compact
// "N events waiting" bar appears above the grid and links to the Review screen.
export function Today() {
  return (
    <div className="today-wrap">
      <GoalRecapBar />
      <div className="today-grid">
        <AgendaCard />
        <MealsColumn />
        <FamilyColumn />
      </div>
    </div>
  )
}
