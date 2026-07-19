import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AuthGate } from './AuthGate'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  authApi: {
    status: mocks.status,
    login: mocks.login,
    setup: mocks.setup,
    startOidc: vi.fn(),
    oidcExchange: vi.fn(),
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

describe('AuthGate accessibility', () => {
  beforeEach(() => {
    mocks.status.mockReset()
    mocks.login.mockReset()
    mocks.setup.mockReset()
  })

  it('labels login fields and focuses an announced sign-in error', async () => {
    mocks.status.mockResolvedValue({ initialized: true, methods: ['password'] })
    mocks.login.mockRejectedValue(new Error('Email or password is incorrect.'))
    renderGate()

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
  })

  it('associates setup validation hints with their fields', async () => {
    mocks.status.mockResolvedValue({ initialized: false, methods: ['password'] })
    renderGate()

    expect(await screen.findByRole('textbox', { name: 'Household name' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeInTheDocument()

    const email = screen.getByRole('textbox', { name: 'Email' })
    fireEvent.change(email, { target: { value: 'not-an-email' } })
    fireEvent.blur(email)

    const hint = screen.getByText(/Enter a valid email address/)
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAttribute('aria-describedby', hint.id)
  })
})
