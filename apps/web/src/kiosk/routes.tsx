import { Routes, Route } from 'react-router'
import { KioskLayout } from './KioskLayout'
import { Today } from './Today'
import { Tasks } from './Tasks'
import { Calendar } from './Calendar'
import { EventDetail } from './EventDetail'
import { Goals } from './Goals'
import { GoalCreate } from './GoalCreate'
import { GoalDetail } from './GoalDetail'
import { PersonProfile } from './PersonProfile'
import { FamilyOverview } from './FamilyOverview'
import { Meals } from './Meals'
import { RecipeDetail } from './RecipeDetail'
import { RecipeEditor } from './RecipeEditor'
import { CookMode } from './CookMode'
import { RecipesLibrary } from './RecipesLibrary'
import { Lists } from './Lists'
import { Pantry } from './Pantry'
import { Photos } from './Photos'
import { Settings } from './Settings'

// Every rail destination has a real component (some still stubs, owned by the
// per-screen agents). Each screen lives in its own file so screens can be built
// independently without touching this router.
export function KioskRoutes() {
  return (
    <Routes>
      <Route element={<KioskLayout />}>
        <Route index element={<Today />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="calendar/event/:id" element={<EventDetail />} />
        <Route path="goals" element={<Goals />} />
        <Route path="goals/new" element={<GoalCreate />} />
        <Route path="goals/:id" element={<GoalDetail />} />
        <Route path="goals/:id/edit" element={<GoalCreate />} />
        <Route path="family" element={<FamilyOverview />} />
        <Route path="person/:id" element={<PersonProfile />} />
        <Route path="meals" element={<Meals />} />
        <Route path="meals/recipes" element={<RecipesLibrary />} />
        <Route path="meals/recipe/new" element={<RecipeEditor />} />
        <Route path="meals/recipe/:id" element={<RecipeDetail />} />
        <Route path="meals/recipe/:id/edit" element={<RecipeEditor />} />
        <Route path="meals/recipe/:id/cook" element={<CookMode />} />
        <Route path="lists" element={<Lists />} />
        <Route path="pantry" element={<Pantry />} />
        <Route path="photos" element={<Photos />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
