import { Routes, Route } from 'react-router'
import { KioskLayout } from './KioskLayout'
import { Today } from './Today'
import { Tasks } from './Tasks'
import { Calendar } from './Calendar'
import { Placeholder } from './components/Placeholder'
import { SCREENS, SETTINGS } from './nav'

const REAL = new Set(['/', '/tasks', '/calendar'])

// Today + Tasks + Calendar are real; the other rail destinations are
// placeholders until their backend domains land.
export function KioskRoutes() {
  return (
    <Routes>
      <Route element={<KioskLayout />}>
        <Route index element={<Today />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="calendar" element={<Calendar />} />
        {[...SCREENS.filter((s) => !REAL.has(s.path)), SETTINGS].map((s) => (
          <Route key={s.path} path={s.path.slice(1)} element={<Placeholder title={s.label} icon={s.icon} />} />
        ))}
      </Route>
    </Routes>
  )
}
