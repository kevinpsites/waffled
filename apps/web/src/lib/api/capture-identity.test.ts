import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  apiSendForIdentity: vi.fn(),
  apiDelete: vi.fn(),
  apiDeleteForIdentity: vi.fn(),
}))

vi.mock('./client', () => ({
  ...client,
  localToday: () => '2026-09-04',
}))

import { groceryApi } from './grocery'
import { mealsApi } from './meals'

beforeEach(() => {
  client.apiGet.mockReset()
  client.apiSend.mockReset()
  client.apiSendForIdentity.mockReset()
  client.apiDelete.mockReset()
  client.apiDeleteForIdentity.mockReset()
})

describe('CaptureBar identity-aware domain helpers', () => {
  it('routes every phase of a list commit through the supplied principal', async () => {
    client.apiSendForIdentity
      .mockResolvedValueOnce({ lists: [] })
      .mockResolvedValueOnce({ list: { id: 'list-1', name: 'Errands' } })
      .mockResolvedValueOnce({ item: { id: 'item-1', name: 'Batteries' } })

    await groceryApi.lists('principal-a')
    await groceryApi.createList({ name: 'Errands' }, 'principal-a')
    await groceryApi.addListItem('list-1', { name: 'Batteries' }, 'principal-a')

    expect(client.apiSendForIdentity).toHaveBeenNthCalledWith(
      1,
      'principal-a',
      'GET',
      '/api/lists',
    )
    expect(client.apiSendForIdentity).toHaveBeenNthCalledWith(
      2,
      'principal-a',
      'POST',
      '/api/lists',
      { name: 'Errands' },
    )
    expect(client.apiSendForIdentity).toHaveBeenNthCalledWith(
      3,
      'principal-a',
      'POST',
      '/api/lists/list-1/items',
      {
        name: 'Batteries',
        quantity: null,
        category: null,
        assignedTo: null,
      },
    )
    expect(client.apiGet).not.toHaveBeenCalled()
    expect(client.apiSend).not.toHaveBeenCalled()
  })

  it('routes the recipe lookup and meal-plan write through the supplied principal', async () => {
    client.apiSendForIdentity
      .mockResolvedValueOnce({ recipes: [{ id: 'recipe-1', title: 'Tacos' }] })
      .mockResolvedValueOnce({ entry: { id: 'entry-1' } })

    await mealsApi.recipes('principal-a')
    await mealsApi.planSlot({ date: '2026-09-04', mealType: 'dinner', recipeId: 'recipe-1' }, 'principal-a')

    expect(client.apiSendForIdentity).toHaveBeenNthCalledWith(
      1,
      'principal-a',
      'GET',
      '/api/recipes',
    )
    expect(client.apiSendForIdentity).toHaveBeenNthCalledWith(
      2,
      'principal-a',
      'POST',
      '/api/meals/plan',
      { date: '2026-09-04', mealType: 'dinner', recipeId: 'recipe-1' },
    )
    expect(client.apiGet).not.toHaveBeenCalled()
    expect(client.apiSend).not.toHaveBeenCalled()
  })
})
