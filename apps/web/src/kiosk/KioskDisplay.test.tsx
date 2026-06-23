import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { KioskDisplay } from './KioskDisplay'

// The load-bearing safety property: a normal/dev browser (display mode off) gets
// ZERO ambient behavior — no screensaver, no dim overlay, no data fetching layer.
describe('KioskDisplay', () => {
  it('is a no-op when display mode is off (dev/normal web)', () => {
    try { localStorage.clear() } catch { /* ignore */ }
    render(
      <MemoryRouter>
        <KioskDisplay><div>app body</div></KioskDisplay>
      </MemoryRouter>
    )
    expect(screen.getByText('app body')).toBeInTheDocument()
    expect(document.querySelector('.ph-saver')).toBeNull()
    expect(document.querySelector('.kiosk-dim')).toBeNull()
  })
})
