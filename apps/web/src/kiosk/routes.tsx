import { Routes, Route } from 'react-router-dom'
import { KioskLayout } from './KioskLayout'
import { Today } from './Today'
import { Tasks } from './Tasks'
import { Placeholder } from './components/Placeholder'
import { SCREENS, SETTINGS } from './nav'

// Today + Tasks are real; the other rail destinations are placeholders until
// their backend domains land. Every rail item navigates to a real route.
export function KioskRoutes() {
  return (
    <Routes>
      <Route element={<KioskLayout />}>
        <Route index element={<Today />} />
        <Route path="tasks" element={<Tasks />} />
        {[...SCREENS.filter((s) => s.path !== '/' && s.path !== '/tasks'), SETTINGS].map((s) => (
          <Route key={s.path} path={s.path.slice(1)} element={<Placeholder title={s.label} icon={s.icon} />} />
        ))}
      </Route>
    </Routes>
  )
}
