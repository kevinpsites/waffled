import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LocationField } from './LocationField'

interface Sent { method: string; url: string; body: unknown }

function mockFetch(sent: Sent[], locations: string[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/pantry/locations') && method === 'POST') {
      return { ok: true, json: async () => ({ locations: [...locations, (body as { name: string }).name], added: true }) }
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
