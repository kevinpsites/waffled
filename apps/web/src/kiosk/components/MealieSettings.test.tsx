import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ApiSendError } from '../../lib/api/client'

vi.mock('../../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/mealie')>()),
  mealieApi: { connection: vi.fn(), saveConnection: vi.fn(), disconnect: vi.fn(), shoppingLists: vi.fn() },
}))

import { mealieApi } from '../../lib/api/mealie'
import { MealieSettings } from './MealieSettings'

const connected = { connected: true, baseUrl: 'http://m:9000', publicUrl: null, shoppingListId: null, shoppingListName: null, mealieVersion: '2.1.0' }
const api = vi.mocked(mealieApi)

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.connection.mockResolvedValue({ connected: false } as never)
  api.saveConnection.mockResolvedValue(connected as never)
  api.shoppingLists.mockResolvedValue([{ id: 'l1', name: 'Weekly' }])
})

describe('MealieSettings (admin)', () => {
  it('saves trimmed values, then loads the list picker and saves the choice', async () => {
    render(<MealieSettings isAdmin />)
    fireEvent.change(await screen.findByLabelText('Mealie URL'), { target: { value: '  http://m:9000  ' } })
    fireEvent.change(screen.getByLabelText('Public URL (optional)'), { target: { value: ' https://food.example ' } })
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: ' tok ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledWith({ baseUrl: 'http://m:9000', publicUrl: 'https://food.example', token: 'tok' }))
    await waitFor(() => expect(api.shoppingLists).toHaveBeenCalled())
    api.saveConnection.mockClear()
    fireEvent.change(await screen.findByLabelText('Shopping list'), { target: { value: 'l1' } })
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledWith({ baseUrl: 'http://m:9000', shoppingListId: 'l1' }))
  })

  it('shows saved token and omits token on re-save when blank', async () => {
    api.connection.mockResolvedValue(connected as never)
    render(<MealieSettings isAdmin />)
    expect(await screen.findByPlaceholderText('••• saved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalled())
    expect(api.saveConnection.mock.calls[0][0]).not.toHaveProperty('token')
  })

  it('asks before disconnecting', async () => {
    api.connection.mockResolvedValue(connected as never)
    api.disconnect.mockResolvedValue(undefined as never)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<MealieSettings isAdmin />)
    const btn = await screen.findByRole('button', { name: 'Disconnect' })
    fireEvent.click(btn)
    expect(api.disconnect).not.toHaveBeenCalled()
    fireEvent.click(btn)
    await waitFor(() => expect(api.disconnect).toHaveBeenCalled())
    confirm.mockRestore()
  })

  it('shows the server message on a save error', async () => {
    api.saveConnection.mockRejectedValue(new ApiSendError('PUT', '/x', 400, { error: 'BadRequest', message: 'Mealie rejected that token' }))
    render(<MealieSettings isAdmin />)
    fireEvent.change(await screen.findByLabelText('Mealie URL'), { target: { value: 'http://m' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Mealie rejected that token')).toBeInTheDocument()
  })
})

describe('MealieSettings (non-admin)', () => {
  it('shows a read-only connected line', async () => {
    api.connection.mockResolvedValue(connected as never)
    render(<MealieSettings isAdmin={false} />)
    expect(await screen.findByText(/Connected to Mealie/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Mealie URL')).toBeNull()
  })
})
