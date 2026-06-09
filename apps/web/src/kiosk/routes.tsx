import { Routes, Route } from 'react-router-dom'
import { KioskLayout } from './KioskLayout'
import { Today } from './Today'
import { Placeholder } from './components/Placeholder'
import { SCREENS, SETTINGS } from './nav'

// Today is real; the other rail destinations are placeholders until their
// backend domains land. Every rail item navigates to a real route.
export function KioskRoutes() {
  return (
    <Routes>
      <Route element={<KioskLayout />}>
        <Route index element={<Today />} />
        {[...SCREENS.filter((s) => s.path !== '/'), SETTINGS].map((s) => (
          <Route key={s.path} path={s.path.slice(1)} element={<Placeholder title={s.label} icon={s.icon} />} />
        ))}
      </Route>
    </Routes>
  )
}
