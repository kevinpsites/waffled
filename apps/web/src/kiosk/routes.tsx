import { Routes, Route } from 'react-router'
import { KioskLayout } from './KioskLayout'
import { Today } from './Today'
import { Tasks } from './Tasks'
import { Calendar } from './Calendar'
import { Goals } from './Goals'
import { GoalCreate } from './GoalCreate'
import { GoalDetail } from './GoalDetail'
import { Meals } from './Meals'
import { Lists } from './Lists'
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
        <Route path="goals" element={<Goals />} />
        <Route path="goals/new" element={<GoalCreate />} />
        <Route path="goals/:id" element={<GoalDetail />} />
        <Route path="meals" element={<Meals />} />
        <Route path="lists" element={<Lists />} />
        <Route path="photos" element={<Photos />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
