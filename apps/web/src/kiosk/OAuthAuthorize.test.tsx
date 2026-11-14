import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { OAuthAuthorize } from './OAuthAuthorize'

const QUERY = '?response_type=code&client_id=wfc_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=x&code_challenge_method=S256&state=s1&resource=https%3A%2F%2Fhome.example%2Fmcp'

const INFO = {
  client: { id: 'wfc_abc', name: 'Claude', redirectHost: 'claude.ai' },
  scopes: [
    { scope: 'family:read', description: 'See your household and its members', write: false },
    { scope: 'calendar:read', description: 'See the family calendar', write: false },
    { scope: 'calendar:write', description: 'Add, move and cancel calendar events', write: true },
  ],
  households: [{ id: 'h1', name: 'Sites', canConnect: true }],
}

type Body = Record<string, unknown>
let posts: Body[] = []

function mockFetch(info: unknown, opts: { status?: number; post?: (b: Body) => unknown } = {}) {
  posts = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('/api/oauth/authorize/info')) {
      expect(u).toBe(`/api/oauth/authorize/info${QUERY}`)
      const status = opts.status ?? 200
      return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => info }
    }
    if (u === '/api/oauth/authorize' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Body
      posts.push(body)
      const out = opts.post ? opts.post(body) : { redirect: 'https://claude.ai/api/mcp/auth_callback?code=c1&state=s1' }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => out }
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderConsent(onLeave = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[`/oauth/authorize${QUERY}`]}>
      <OAuthAuthorize onLeave={onLeave} />
    </MemoryRouter>
  )
  return onLeave
}

describe('OAuth consent screen', () => {
  it('names the app and where it sends you, with reads on and writes off', async () => {
    mockFetch(INFO)
    renderConsent()
    expect(await screen.findByRole('heading', { name: /Connect Claude/ })).toBeInTheDocument()
    expect(screen.getByText('claude.ai')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /See your household and its members/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: /See the family calendar/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: /Add, move and cancel calendar events/ })).toHaveAttribute('aria-checked', 'false')
    // One household: nothing to pick.
    expect(screen.queryByRole('combobox', { name: /Household/ })).not.toBeInTheDocument()
  })

  it('approves the chosen scopes for the household and leaves for the returned URL', async () => {
    mockFetch(INFO)
    const onLeave = renderConsent()
    fireEvent.click(await screen.findByRole('switch', { name: /Add, move and cancel calendar events/ }))
    fireEvent.click(screen.getByRole('switch', { name: /See your household and its members/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?code=c1&state=s1'))
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      client_id: 'wfc_abc',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      state: 's1',
      resource: 'https://home.example/mcp',
      householdId: 'h1',
      decision: 'approve',
    })
    expect(posts[0].scopes).toEqual(['calendar:read', 'calendar:write'])
  })

  it('cannot approve with nothing selected', async () => {
    mockFetch(INFO)
    renderConsent()
    fireEvent.click(await screen.findByRole('switch', { name: /See your household and its members/ }))
    fireEvent.click(screen.getByRole('switch', { name: /See the family calendar/ }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('cancel declines through the server and leaves for its access_denied URL', async () => {
    mockFetch(INFO, { post: () => ({ redirect: 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s1' }) })
    const onLeave = renderConsent()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s1'))
    expect(posts[0].decision).toBe('deny')
  })

  it('offers a household picker of only the households you may connect', async () => {
    mockFetch({
      ...INFO,
      households: [
        { id: 'h1', name: 'Sites', canConnect: true },
        { id: 'h2', name: 'Cabin', canConnect: true },
        { id: 'h3', name: 'Grandma', canConnect: false },
      ],
    })
    const onLeave = renderConsent()
    const picker = await screen.findByRole('combobox', { name: /Household/ })
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Sites', 'Cabin'])
    fireEvent.change(picker, { target: { value: 'h2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onLeave).toHaveBeenCalled())
    expect(posts[0].householdId).toBe('h2')
  })

  it('refuses a person without permission to connect AI apps', async () => {
    mockFetch({ ...INFO, households: [{ id: 'h1', name: 'Sites', canConnect: false }] })
    renderConsent()
    expect(await screen.findByText(/can’t connect AI apps/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('shows an unusable request instead of redirecting when the client is not verified', async () => {
    mockFetch({ error: 'invalid_client', error_description: 'Unknown client' }, { status: 400 })
    const onLeave = renderConsent()
    expect(await screen.findByText('Unknown client')).toBeInTheDocument()
    expect(onLeave).not.toHaveBeenCalled()
  })

  it('returns a redirectable error to the app', async () => {
    mockFetch({ error: 'invalid_scope', error_description: 'unknown scope', redirect: 'https://claude.ai/api/mcp/auth_callback?error=invalid_scope&state=s1' }, { status: 400 })
    const onLeave = renderConsent()
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith('https://claude.ai/api/mcp/auth_callback?error=invalid_scope&state=s1'))
  })
})
