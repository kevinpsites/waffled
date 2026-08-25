import { lazy } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router'
import { useHousehold } from '../lib/api'
import { moduleEnabled, type ModuleKey } from '../lib/modules'
import { KioskLayout } from './KioskLayout'

// Every screen is loaded on demand. Statically imported, all twenty landed in the
// entry bundle, so opening the kiosk to Today downloaded Settings, the recipe
// editor and the pantry too. lazy() gives each screen its own chunk, fetched the
// first time someone navigates to it; KioskLayout holds the <Suspense> boundary so
// the rail and topbar stay put while a chunk loads.
//
// KioskLayout itself stays eager — it is the shell, needed on literally every route.
const Today = lazy(() => import('./Today').then((m) => ({ default: m.Today })))
const Tasks = lazy(() => import('./Tasks').then((m) => ({ default: m.Tasks })))
const Calendar = lazy(() => import('./Calendar').then((m) => ({ default: m.Calendar })))
const EventDetail = lazy(() => import('./EventDetail').then((m) => ({ default: m.EventDetail })))
const Goals = lazy(() => import('./Goals').then((m) => ({ default: m.Goals })))
const GoalCreate = lazy(() => import('./GoalCreate').then((m) => ({ default: m.GoalCreate })))
const GoalDetail = lazy(() => import('./GoalDetail').then((m) => ({ default: m.GoalDetail })))
const PersonProfile = lazy(() => import('./PersonProfile').then((m) => ({ default: m.PersonProfile })))
const WaffledBiteDevice = lazy(() => import('./WaffledBiteDevice').then((m) => ({ default: m.WaffledBiteDevice })))
const FamilyOverview = lazy(() => import('./FamilyOverview').then((m) => ({ default: m.FamilyOverview })))
const Meals = lazy(() => import('./Meals').then((m) => ({ default: m.Meals })))
const RecipeDetail = lazy(() => import('./RecipeDetail').then((m) => ({ default: m.RecipeDetail })))
const RecipeEditor = lazy(() => import('./RecipeEditor').then((m) => ({ default: m.RecipeEditor })))
const CookMode = lazy(() => import('./CookMode').then((m) => ({ default: m.CookMode })))
const RecipesLibrary = lazy(() => import('./RecipesLibrary').then((m) => ({ default: m.RecipesLibrary })))
const MealBuilder = lazy(() => import('./MealBuilder').then((m) => ({ default: m.MealBuilder })))
const Lists = lazy(() => import('./Lists').then((m) => ({ default: m.Lists })))
const Pantry = lazy(() => import('./Pantry').then((m) => ({ default: m.Pantry })))
const Photos = lazy(() => import('./Photos').then((m) => ({ default: m.Photos })))
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })))

// Layout route that redirects to Today when an optional module is off, so a
// bookmark/direct URL to a disabled page doesn't render a dead (403-ing) screen.
// While the household is still loading it's null → moduleEnabled falls back to the
// catalog default (on), so the common case never flashes a redirect.
function ModuleGate({ module }: { module: ModuleKey }) {
  const { household } = useHousehold()
  // Wait for settings to load before deciding — otherwise a default-off module
  // (pantry) would flash-redirect on the null household during the initial fetch.
  if (!household) return null
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
        <Route path="person/:id/waffled-bite" element={<WaffledBiteDevice />} />
        <Route element={<ModuleGate module="meals" />}>
          <Route path="meals" element={<Meals />} />
          <Route path="meals/recipes" element={<RecipesLibrary />} />
          {/* Meal Builder. /meals/build starts an empty plate; /meals/build/:id edits
              an existing one. Gated with the rest of meals — a plate is meaningless
              without recipes. */}
          <Route path="meals/build" element={<MealBuilder />} />
          <Route path="meals/build/:id" element={<MealBuilder />} />
          <Route path="meals/recipe/new" element={<RecipeEditor />} />
          <Route path="meals/recipe/:id" element={<RecipeDetail />} />
          <Route path="meals/recipe/:id/edit" element={<RecipeEditor />} />
          <Route path="meals/recipe/:id/cook" element={<CookMode />} />
          {/* Cooking a whole plate: the same screen, but tabbed across the meal's
              dishes with independent step progress per dish. Registered here so the
              Cook Mode work never has to edit this router. */}
          <Route path="meals/meal/:id/cook" element={<CookMode />} />
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
