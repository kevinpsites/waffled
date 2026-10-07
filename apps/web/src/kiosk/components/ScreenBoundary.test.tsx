import { render, screen } from '@testing-library/react'
import { ScreenBoundary } from './ScreenBoundary'
import { Placeholder } from './Placeholder'

// The fallback is the one screen a wall-mounted display can end up sitting on for
// hours, so it has to look like the rest of the app rather than a bare card with
// hand-tuned inline spacing. `Placeholder` is the centred full-screen layout the
// kiosk already uses; the boundary should render through it, not reinvent it.

function Boom(): never {
  throw new Error('chunk went missing')
}

// React logs the caught error to the console; a boundary test would otherwise print
// a component stack on every run and read as a failure.
const consoleError = console.error
beforeEach(() => {
  console.error = () => {}
})
afterEach(() => {
  console.error = consoleError
})

test('renders its children while nothing throws', () => {
  render(
    <ScreenBoundary>
      <div>the screen</div>
    </ScreenBoundary>
  )
  expect(screen.getByText('the screen')).toBeTruthy()
  expect(screen.queryByText(/This screen couldn’t load/)).toBeNull()
})

test('falls back to the shared placeholder layout instead of hand-rolled spacing', () => {
  const { container } = render(
    <ScreenBoundary>
      <Boom />
    </ScreenBoundary>
  )

  const fallback = container.querySelector('.screen-placeholder')
  expect(fallback).not.toBeNull()
  // The point of the change: no bespoke margin/padding/text-align on the fallback.
  // `.screen-placeholder` owns the centring, so an inline style here means the
  // layout drifted away from every other full-screen state in the app.
  expect(fallback?.getAttribute('style')).toBeNull()
  expect(screen.getByText(/This screen couldn’t load/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
})

test('does not inherit the placeholder default copy meant for unbuilt screens', () => {
  render(
    <ScreenBoundary>
      <Boom />
    </ScreenBoundary>
  )
  // "Coming soon — this screen lights up as its backend lands." is right for a screen
  // that does not exist yet and actively wrong for one that failed to download.
  expect(screen.queryByText(/Coming soon/)).toBeNull()
})

test('Placeholder still shows its default copy when given no body', () => {
  render(<Placeholder title="Upkeep" icon="tasks" />)
  expect(screen.getByText('Upkeep')).toBeTruthy()
  expect(screen.getByText(/Coming soon/)).toBeTruthy()
})
