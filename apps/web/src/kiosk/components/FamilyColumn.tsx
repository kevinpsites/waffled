import { ChoresCard } from './ChoresCard'
import { GroceryCard } from './GroceryCard'

// The right column of the Today dashboard: family chores + grocery.
export function FamilyColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minHeight: 0 }}>
      <ChoresCard />
      <GroceryCard />
    </div>
  )
}
