import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { MemoryRouter } from 'react-router'
import { AuthGate } from './AuthGate'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
  accessToken: null as string | null,
  identityScope: null as string | null,
  acceptedIdentityScope: null as string | null,
  acknowledgeIdentityScope: vi.fn<(scope: string | null) => boolean>(),
  afterAccessTokenRead: null as null | (() => void),
  transitionInProgress: vi.fn(() => false),
  waitForTransition: vi.fn(() => Promise.resolve()),
}))

vi.mock('../lib/api', () => ({
  authApi: {
    status: mocks.status,
    login: mocks.login,
    setup: mocks.setup,
    startOidc: vi.fn(),
    oidcExchange: vi.fn(),
  },
  getAccessToken: () => {
    const token = mocks.identityScope === mocks.acceptedIdentityScope
      ? mocks.accessToken
      : null
    const afterRead = mocks.afterAccessTokenRead
    mocks.afterAccessTokenRead = null
    afterRead?.()
    return token
  },
  currentIdentityScope: () => mocks.identityScope,
  acknowledgeCurrentIdentityScopeAfterGate: (scope: string | null) =>
    mocks.acknowledgeIdentityScope(scope),
  isKioskMode: () => false,
}))

vi.mock('../lib/powersync/principal-transition', () => ({
  principalTransitionInProgress: mocks.transitionInProgress,
  waitForPrincipalTransition: mocks.waitForTransition,
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
    mocks.accessToken = null
    mocks.identityScope = null
    mocks.acceptedIdentityScope = null
    mocks.acknowledgeIdentityScope.mockReset()
    mocks.acknowledgeIdentityScope.mockImplementation((scope) => {
      if (scope !== mocks.identityScope) return false
      mocks.acceptedIdentityScope = scope
      return true
    })
    mocks.afterAccessTokenRead = null
    mocks.transitionInProgress.mockReset()
    mocks.transitionInProgress.mockReturnValue(false)
    mocks.waitForTransition.mockReset()
    mocks.waitForTransition.mockResolvedValue(undefined)
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

  it('closes the render-to-subscribe gap when a transition starts before effects run', async () => {
    mocks.accessToken = 'account-a-token'
    mocks.acceptedIdentityScope = mocks.identityScope
    mocks.transitionInProgress
      .mockReturnValueOnce(false) // useState initializer
      .mockReturnValue(true) // subscribe-then-check in the effect
    mocks.waitForTransition.mockReturnValue(new Promise<void>(() => {}))

    renderGate()

    await waitFor(() => expect(screen.queryByText('Signed in')).not.toBeInTheDocument())
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('re-resolves when a transition changes scope and finishes before effects subscribe', async () => {
    mocks.identityScope = 'session:account-a'
    mocks.acceptedIdentityScope = mocks.identityScope
    mocks.accessToken = 'account-a-token'
    mocks.status.mockResolvedValue({ initialized: true, methods: ['password'] })
    // The initializer sees account A. Before the subscription is installed, a
    // remote tab finishes A -> signed-out and leaves no active start marker.
    mocks.afterAccessTokenRead = () => {
      mocks.identityScope = null
      mocks.accessToken = null
    }

    renderGate()

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
  })

  it('shows fail-closed recovery when transition liveness cannot be proven', async () => {
    mocks.accessToken = 'account-a-token'
    mocks.acceptedIdentityScope = mocks.identityScope
    mocks.transitionInProgress.mockReturnValue(true)
    mocks.waitForTransition.mockRejectedValue(new Error('no Web Locks liveness proof'))

    renderGate()

    expect(await screen.findByText('Private data is still locked')).toBeInTheDocument()
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload and try again' })).toBeInTheDocument()
  })

  it('does not let a stale status response overwrite transition recovery', async () => {
    let finishStatus!: (value: { initialized: boolean; methods: string[] }) => void
    mocks.status.mockReturnValue(new Promise((resolve) => { finishStatus = resolve }))
    mocks.waitForTransition.mockRejectedValue(new Error('transition failed'))

    renderGate()
    await waitFor(() => expect(mocks.status).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('waffled:principal-transition-started'))
    expect(await screen.findByText('Private data is still locked')).toBeInTheDocument()

    finishStatus({ initialized: true, methods: ['password'] })
    await Promise.resolve()

    expect(screen.getByText('Private data is still locked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('acknowledges a remote session only after the prior principal tree is gated', async () => {
    mocks.identityScope = 'session:account-a'
    mocks.acceptedIdentityScope = mocks.identityScope
    mocks.accessToken = 'account-a-token'
    renderGate()
    const priorTree = await screen.findByText('Signed in')

    mocks.identityScope = 'session:account-b'
    mocks.accessToken = 'account-b-token'
    mocks.acknowledgeIdentityScope.mockImplementation((scope) => {
      expect(scope).toBe('session:account-b')
      expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
      mocks.acceptedIdentityScope = scope
      return true
    })
    act(() => window.dispatchEvent(new Event('waffled:auth-changed')))

    await waitFor(() => expect(mocks.acknowledgeIdentityScope).toHaveBeenCalledWith('session:account-b'))
    const replacementTree = await screen.findByText('Signed in')
    expect(replacementTree).not.toBe(priorTree)
  })
})
