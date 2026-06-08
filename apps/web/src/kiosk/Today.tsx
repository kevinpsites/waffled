import { AgendaCard } from './components/AgendaCard'
import { MealsColumn } from './components/MealsColumn'
import { FamilyColumn } from './components/FamilyColumn'

// The kiosk "Today" dashboard: agenda · meals · family chores + grocery.
export function Today() {
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1.15fr 1fr .82fr',
        gap: 18,
        padding: '6px 30px 26px',
        minHeight: 0,
      }}
    >
      <AgendaCard />
      <MealsColumn />
      <FamilyColumn />
    </div>
  )
}
