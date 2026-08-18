import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LocationField } from './LocationField'

interface Sent { method: string; url: string; body: unknown }

// Stands in for POST /api/pantry/locations, matching what the route actually does:
// a name that already exists in ANY casing is a no-op that hands back the list the
// household already has, so the canonical spelling is the one in the response.
function mockFetch(sent: Sent[], locations: string[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/pantry/locations') && method === 'POST') {
      const name = (body as { name: string }).name
      const existing = locations.find((l) => l.toLowerCase() === name.toLowerCase())
      return existing
        ? { ok: true, json: async () => ({ locations, added: false }) }
        : { ok: true, json: async () => ({ locations: [...locations, name], added: true }) }
    }
    return { ok: true, json: async () => ({}) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
}

describe('LocationField', () => {
  it('offers the configured sections', () => {
    render(<LocationField value="Fridge" locations={['Freezer', 'Fridge', 'Pantry']} onChange={() => {}} />)
    const select = screen.getByLabelText('Location') as HTMLSelectElement
    expect(select.value).toBe('Fridge')
    expect(Array.from(select.options).map((o) => o.text)).toContain('Freezer')
  })

  // The whole point of the fix: you shouldn't have to leave the add sheet and go to
  // Settings just because the thing you're holding belongs somewhere new.
  it('creates a new section inline and selects it', async () => {
    const sent: Sent[] = []
    mockFetch(sent, ['Freezer', 'Fridge', 'Pantry'])
    const onChange = vi.fn()
    const onLocationsChanged = vi.fn()
    render(
      <LocationField value="Fridge" locations={['Freezer', 'Fridge', 'Pantry']} onChange={onChange} onLocationsChanged={onLocationsChanged} />
    )

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '__new__' } })
    const input = screen.getByPlaceholderText('New section name')
    fireEvent.change(input, { target: { value: '  Garage shelf ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Garage shelf'))
    expect(sent.filter((s) => s.method === 'POST')).toEqual([
      { method: 'POST', url: expect.stringContaining('/api/pantry/locations'), body: { name: 'Garage shelf' } },
    ])
    expect(onLocationsChanged).toHaveBeenCalled()
    // Back to the picker, with the new section chosen.
    await waitFor(() => expect(screen.queryByPlaceholderText('New section name')).toBeNull())
  })

  // Typing a section that already exists in a different casing has to file the item
  // under the household's spelling. Both list views bucket by an exact string match,
  // so selecting the typed casing would strand the item in the "Other" catch-all.
  it('selects the household spelling when the name only differs in casing', async () => {
    const sent: Sent[] = []
    mockFetch(sent, ['Freezer', 'Fridge', 'Garage shelf'])
    const onChange = vi.fn()
    render(
      <LocationField value="Fridge" locations={['Freezer', 'Fridge', 'Garage shelf']} onChange={onChange} />
    )

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('New section name'), { target: { value: 'garage shelf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenCalledWith('Garage shelf')
  })

  it('will not add a blank section, and cancel returns to the picker', async () => {
    const sent: Sent[] = []
    mockFetch(sent, ['Pantry'])
    render(<LocationField value="Pantry" locations={['Pantry']} onChange={() => {}} />)

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '__new__' } })
    expect(screen.getByRole('button', { name: 'Add section' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel new section' }))
    expect(screen.queryByPlaceholderText('New section name')).toBeNull()
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(0)
  })
})
