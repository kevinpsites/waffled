import { render, screen, waitFor } from '@testing-library/react'

vi.mock('./api/mealie', async (orig) => ({ ...(await orig<typeof import('./api/mealie')>()), mealieApi: { connection: vi.fn() } }))

import { mealieApi } from './api/mealie'
import { MealieProvider, useMealie } from './mealie-context'

function Probe() {
  const m = useMealie()
  return <div>{`loading=${m.loading} connected=${m.connected} list=${m.hasShoppingList}`}</div>
}

describe('MealieProvider', () => {
  it('reports connected from connection()', async () => {
    vi.mocked(mealieApi.connection).mockResolvedValue({ connected: true, baseUrl: 'http://m', publicUrl: null, shoppingListId: 'l1', shoppingListName: 'L', mealieVersion: '2.0.0' })
    render(<MealieProvider><Probe /></MealieProvider>)
    expect(screen.getByText(/loading=true connected=false/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('loading=false connected=true list=true')).toBeInTheDocument())
  })
  it('is not connected when connection() rejects', async () => {
    vi.mocked(mealieApi.connection).mockRejectedValue(new Error('x'))
    render(<MealieProvider><Probe /></MealieProvider>)
    await waitFor(() => expect(screen.getByText('loading=false connected=false list=false')).toBeInTheDocument())
  })
  it('defaults to not connected without a provider', () => {
    render(<Probe />)
    expect(screen.getByText('loading=false connected=false list=false')).toBeInTheDocument()
  })
})
