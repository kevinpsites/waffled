import { Routes, Route, Navigate, Outlet } from 'react-router'
import { useHousehold } from '../lib/api'
import { moduleEnabled, type ModuleKey } from '../lib/modules'
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

// Layout route that redirects to Today when an optional module is off, so a
// bookmark/direct URL to a disabled page doesn't render a dead (403-ing) screen.
// While the household is still loading it's null → moduleEnabled falls back to the
// catalog default (on), so the common case never flashes a redirect.
function ModuleGate({ module }: { module: ModuleKey }) {
  const { household } = useHousehold()
  if (!moduleEnabled(household, module)) return <Navigate to="/" replace />
  return <Outlet />
}

// Every rail destination has a real component (some still stubs, owned by the
// per-screen agents). Each screen lives in its own file so screens can be built
// independently without touching this router. Optional-module pages sit under a
// <ModuleGate> so they're hidden (redirected) when the module is off — Today and
// Calendar are never gated.
export function KioskRoutes() {
  return (
    <Routes>
      <Route element={<KioskLayout />}>
        <Route index element={<Today />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="calendar/event/:id" element={<EventDetail />} />
        <Route element={<ModuleGate module="chores" />}>
          <Route path="tasks" element={<Tasks />} />
        </Route>
        <Route element={<ModuleGate module="goals" />}>
          <Route path="goals" element={<Goals />} />
          <Route path="goals/new" element={<GoalCreate />} />
          <Route path="goals/:id" element={<GoalDetail />} />
          <Route path="goals/:id/edit" element={<GoalCreate />} />
        </Route>
        <Route path="family" element={<FamilyOverview />} />
        <Route path="person/:id" element={<PersonProfile />} />
        <Route element={<ModuleGate module="meals" />}>
          <Route path="meals" element={<Meals />} />
          <Route path="meals/recipes" element={<RecipesLibrary />} />
          <Route path="meals/recipe/new" element={<RecipeEditor />} />
          <Route path="meals/recipe/:id" element={<RecipeDetail />} />
          <Route path="meals/recipe/:id/edit" element={<RecipeEditor />} />
          <Route path="meals/recipe/:id/cook" element={<CookMode />} />
        </Route>
        <Route element={<ModuleGate module="lists" />}>
          <Route path="lists" element={<Lists />} />
        </Route>
        <Route element={<ModuleGate module="pantry" />}>
          <Route path="pantry" element={<Pantry />} />
        </Route>
        <Route path="photos" element={<Photos />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
