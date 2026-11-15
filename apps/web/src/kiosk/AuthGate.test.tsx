import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import axe from 'axe-core'
import { MemoryRouter, useLocation } from 'react-router'
import { AuthGate } from './AuthGate'
import { rememberReturnPath } from '../lib/returnPath'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
  oidcExchange: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  authApi: {
    status: mocks.status,
    login: mocks.login,
    setup: mocks.setup,
    startOidc: vi.fn(),
    oidcExchange: mocks.oidcExchange,
  },
  getAccessToken: () => null,
  isKioskMode: () => false,
}))

function renderGate() {
  return render(
    <MemoryRouter>
      <AuthGate><div>Signed in</div></AuthGate>
    </MemoryRouter>,
  )
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      // jsdom cannot calculate rendered colors or page-level landmark coverage.
      'color-contrast': { enabled: false },
      region: { enabled: false },
    },
  })
  expect(results.violations).toEqual([])
}

describe('AuthGate accessibility', () => {
  beforeEach(() => {
    mocks.status.mockReset()
    mocks.login.mockReset()
    mocks.setup.mockReset()
  })

  it('labels login fields and focuses an announced sign-in error', async () => {
    mocks.status.mockResolvedValue({ initialized: true, methods: ['password'] })
    mocks.login.mockRejectedValue(new Error('Email or password is incorrect.'))
    const { container } = renderGate()

    const email = await screen.findByRole('textbox', { name: 'Email' })
    const password = screen.getByLabelText('Password')
    fireEvent.change(email, { target: { value: 'alex@example.com' } })
    fireEvent.change(password, { target: { value: 'bad password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('Email or password is incorrect.')
    await waitFor(() => expect(error).toHaveFocus())
    expect(email).toHaveAttribute('aria-describedby', 'login-error')
    expect(password).toHaveAttribute('aria-describedby', 'login-error')
    await expectNoAxeViolations(container)
  }, 30_000)

  it('associates setup validation hints with their fields', async () => {
    mocks.status.mockResolvedValue({ initialized: false, methods: ['password'] })
    const { container } = renderGate()

    expect(await screen.findByRole('textbox', { name: 'Household name' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeInTheDocument()

    const email = screen.getByRole('textbox', { name: 'Email' })
    fireEvent.change(email, { target: { value: 'not-an-email' } })
    fireEvent.blur(email)

    const hint = screen.getByText(/Enter a valid email address/)
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAttribute('aria-describedby', hint.id)
    await expectNoAxeViolations(container)
  }, 30_000)
})

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{loc.pathname + loc.search}</div>
}

describe('AuthGate OIDC return', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/')
    sessionStorage.clear()
  })

  it('router-navigates back to the page that started sign-in, query intact', async () => {
    const consent = '/oauth/authorize?client_id=wfc_1&state=s%201&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb'
    window.history.pushState({}, '', consent)
    rememberReturnPath()
    window.history.pushState({}, '', '/auth/callback?code=handoff-1')
    mocks.oidcExchange.mockResolvedValue(undefined)
    mocks.status.mockResolvedValue({ initialized: true, methods: ['password'] })

    render(
      <MemoryRouter initialEntries={['/auth/callback?code=handoff-1']}>
        <AuthGate><div>Signed in</div></AuthGate>
        <Where />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(consent))
    expect(mocks.oidcExchange).toHaveBeenCalledWith('handoff-1')
    expect(sessionStorage.getItem('waffled.returnTo')).toBeNull()
  })

  it('never returns to another origin', async () => {
    sessionStorage.setItem('waffled.returnTo', '//evil.example/x')
    window.history.pushState({}, '', '/auth/callback?code=handoff-2')
    mocks.oidcExchange.mockResolvedValue(undefined)
    mocks.status.mockResolvedValue({ initialized: true, methods: ['password'] })

    render(
      <MemoryRouter initialEntries={['/auth/callback?code=handoff-2']}>
        <AuthGate><div>Signed in</div></AuthGate>
        <Where />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.oidcExchange).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/))
  })
})
