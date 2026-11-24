import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ApiSendError } from '../../lib/api/client'
import { emit } from '../../lib/api/bus'

const shopping = vi.fn()
const addItem = vi.fn()
const setChecked = vi.fn()
vi.mock('../../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/mealie')>()),
  mealieApi: { shopping: () => shopping(), addItem: (t: string) => addItem(t), setChecked: (id: string, c: boolean) => setChecked(id, c) },
}))

import { MealieShoppingList } from './MealieShoppingList'

const item = (id: string, display: string, checked = false, label: { name: string; color: string | null } | null = null, position = 0) =>
  ({ id, display, checked, label, position })
const produce = { name: 'Produce', color: '#3a3' }
const data = () => ({
  listId: 'L', listName: 'Groceries',
  items: [
    item('a', 'Apples', false, produce, 0),
    item('b', 'Bread', false, null, 1),
    item('c', 'Carrots', true, produce, 2),
  ],
})

beforeEach(() => { shopping.mockReset().mockResolvedValue(data()); addItem.mockReset().mockResolvedValue({ ok: true }); setChecked.mockReset() })

describe('MealieShoppingList', () => {
  it('groups by label with a colour accent and collapses checked items', async () => {
    render(<MealieShoppingList />)
    const heading = await screen.findByText('Produce')
    expect(heading.closest('[data-label-color]')?.getAttribute('data-label-color')).toBe('#3a3')
    expect(screen.getByText('Apples')).toBeTruthy()
    expect(screen.getByText('Bread')).toBeTruthy()
    expect(screen.queryByText('Carrots')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Checked \(1\)/ }))
    expect(screen.getByText('Carrots')).toBeTruthy()
  })

  it('checks optimistically, calls setChecked, and ignores a second tap in flight', async () => {
    let resolve!: () => void
    setChecked.mockReturnValue(new Promise<void>((r) => { resolve = r }))
    render(<MealieShoppingList />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apples' }))
    expect(setChecked).toHaveBeenCalledWith('a', true)
    await waitFor(() => expect(screen.queryByText('Apples')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Checked \(2\)/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Apples' }))
    expect(setChecked).toHaveBeenCalledTimes(1)
    await act(async () => { resolve() })
  })

  it('reverts and shows an alert when the PATCH rejects', async () => {
    setChecked.mockRejectedValue(new ApiSendError('PATCH', '/x', 502, { error: 'MealieUnavailable' }))
    render(<MealieShoppingList />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apples' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Apples')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Checked \(1\)/ })).toBeTruthy()
  })

  it('adds an item and clears the field; empty is a no-op', async () => {
    render(<MealieShoppingList />)
    const input = await screen.findByLabelText('Add to shopping list')
    fireEvent.submit(input.closest('form')!)
    expect(addItem).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '  milk ' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(addItem).toHaveBeenCalledWith('milk'))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
  })

  it('renders the no-shopping-list copy', async () => {
    shopping.mockRejectedValue(new ApiSendError('GET', '/x', 409, { error: 'MealieNoShoppingList' }))
    render(<MealieShoppingList />)
    expect(await screen.findByText('Choose a shopping list in Settings → Mealie.')).toBeTruthy()
  })

  describe('optimistic overlay vs refetch', () => {
    const withApples = (checked: boolean) => ({ ...data(), items: data().items.map((i) => (i.id === 'a' ? { ...i, checked } : i)) })
    const openChecked = async () => {
      render(<MealieShoppingList />)
      fireEvent.click(await screen.findByRole('button', { name: 'Apples' }))
    }
    const refetch = async () => { await act(async () => { emit('mealie') }) }

    it('keeps the item checked when stale data lands while the PATCH is pending', async () => {
      setChecked.mockReturnValue(new Promise(() => {}))
      await openChecked()
      shopping.mockResolvedValue(withApples(false))
      await refetch()
      expect(screen.queryByText('Apples')).toBeNull()
      expect(screen.getByRole('button', { name: /Checked \(2\)/ })).toBeTruthy()
    })

    it('stays checked after the PATCH resolves and confirmed data arrives', async () => {
      setChecked.mockResolvedValue({ ok: true })
      await openChecked()
      await waitFor(() => expect(setChecked).toHaveBeenCalled())
      shopping.mockResolvedValue(withApples(true))
      await refetch()
      expect(screen.getByRole('button', { name: /Checked \(2\)/ })).toBeTruthy()
    })

    it('follows the server when the item is toggled elsewhere after the write', async () => {
      setChecked.mockResolvedValue({ ok: true })
      await openChecked()
      await waitFor(() => expect(setChecked).toHaveBeenCalled())
      shopping.mockResolvedValue(withApples(true))
      await refetch()
      shopping.mockResolvedValue(withApples(false))
      await refetch()
      expect(await screen.findByText('Apples')).toBeTruthy()
      expect(screen.getByRole('button', { name: /Checked \(1\)/ })).toBeTruthy()
    })
  })

  it('shows the error with Retry while keeping the list when a refetch fails', async () => {
    render(<MealieShoppingList />)
    await screen.findByText('Apples')
    shopping.mockRejectedValue(new ApiSendError('GET', '/x', 502, { error: 'MealieUnavailable', message: 'x' }))
    await act(async () => { emit('mealie') })
    expect((await screen.findByRole('alert')).textContent).toMatch(/Can't reach Mealie/)
    expect(screen.getByText('Apples')).toBeTruthy()
    shopping.mockResolvedValue(data())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText(/Can't reach Mealie/)).toBeNull())
  })
})
