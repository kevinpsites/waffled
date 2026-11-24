import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ApiSendError } from '../lib/api/client'
import { emit } from '../lib/api/bus'

const mealplan = vi.fn()
const recipes = vi.fn()
const unplan = vi.fn()
const plan = vi.fn()
const hh = { weekStart: 'sunday' as string, timezone: 'UTC' }
vi.mock('../lib/api/client', async (orig) => ({
  ...(await orig<typeof import('../lib/api/client')>()),
  authFetch: vi.fn(async () => new Response(new Blob(['x']))),
}))
URL.createObjectURL = vi.fn(() => 'blob:img')
URL.revokeObjectURL = vi.fn()
vi.mock('../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../lib/api/mealie')>()),
  mealieApi: {
    mealplan: (...a: unknown[]) => mealplan(...a),
    recipes: (...a: unknown[]) => recipes(...a),
    unplan: (...a: unknown[]) => unplan(...a),
    plan: (...a: unknown[]) => plan(...a),
  },
}))
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  useHousehold: () => ({ household: hh }),
}))

import { MealieMeals } from './MealieMeals'

const unavailable = () => new ApiSendError('GET', '/x', 502, { error: 'MealieUnavailable', message: 'x' })
const card = (id: string, name: string, imageUrl: string | null = null) => ({ id, slug: id, name, imageUrl, totalTime: null, description: null })
const wrap = () => render(<MemoryRouter><MealieMeals /></MemoryRouter>)

// 2026-11-25 is a Wednesday.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
  hh.weekStart = 'sunday'
  mealplan.mockReset().mockResolvedValue({ entries: [] })
  recipes.mockReset().mockResolvedValue({ items: [], page: 1, totalPages: 1 })
  // The real client emits 'mealie' after a write; the mocked client must too.
  unplan.mockReset().mockImplementation(async () => { emit('mealie') })
  plan.mockReset().mockImplementation(async () => { emit('mealie') })
})
afterEach(() => { vi.useRealTimers() })

describe('MealieMeals — This week', () => {
  it('shows 7 days from the household week start and requests that range', async () => {
    wrap()
    await waitFor(() => expect(mealplan).toHaveBeenCalledWith('2026-11-22', '2026-11-28'))
    const days = Array.from(document.querySelectorAll('[data-day]')).map((e) => e.getAttribute('data-day'))
    expect(days).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'])
  })

  it('starts on Monday when the household does', async () => {
    hh.weekStart = 'monday'
    wrap()
    await waitFor(() => expect(mealplan).toHaveBeenCalledWith('2026-11-23', '2026-11-29'))
  })

  it('prev and next shift the range by 7 days', async () => {
    wrap()
    await waitFor(() => expect(mealplan).toHaveBeenCalledWith('2026-11-22', '2026-11-28'))
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(mealplan).toHaveBeenCalledWith('2026-11-29', '2026-12-05'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    await waitFor(() => expect(mealplan).toHaveBeenCalledWith('2026-11-15', '2026-11-21'))
  })

  it('asks for confirmation before removing an entry', async () => {
    mealplan.mockResolvedValue({ entries: [{ id: 7, date: '2026-11-25', entryType: 'dinner', title: 'Tacos', recipe: null }] })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Tacos' }))
    expect(unplan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(unplan).toHaveBeenCalledWith(7))
  })

  it('refetches and drops the entry after a confirmed remove', async () => {
    const e = { id: 7, date: '2026-11-25', entryType: 'dinner', title: 'Tacos', recipe: null }
    mealplan.mockResolvedValueOnce({ entries: [e] }).mockResolvedValue({ entries: [] })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Tacos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(mealplan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Tacos')).toBeNull())
  })

  it('refetches and shows the new entry after planning from the modal', async () => {
    mealplan.mockResolvedValueOnce({ entries: [] }).mockResolvedValue({ entries: [{ id: 9, date: '2026-11-25', entryType: 'dinner', title: 'Pizza', recipe: null }] })
    wrap()
    await waitFor(() => expect(mealplan).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Plan a meal' }))
    fireEvent.change(screen.getByPlaceholderText('Or type a title'), { target: { value: 'Pizza' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(plan).toHaveBeenCalled())
    await waitFor(() => expect(mealplan).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Pizza')).toBeTruthy()
  })

  it('does not remove when the confirmation is cancelled', async () => {
    mealplan.mockResolvedValue({ entries: [{ id: 7, date: '2026-11-25', entryType: 'dinner', title: 'Tacos', recipe: null }] })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Tacos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(unplan).not.toHaveBeenCalled()
  })

  it('opens the plan modal from Plan a meal', async () => {
    wrap()
    fireEvent.click(screen.getByRole('button', { name: 'Plan a meal' }))
    expect(document.querySelector('.modal-card')).toBeTruthy()
  })

  it('shows MealieError with Retry when unavailable', async () => {
    mealplan.mockRejectedValueOnce(unavailable())
    wrap()
    expect(await screen.findByText("Can't reach Mealie right now.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mealplan).toHaveBeenCalledTimes(2))
  })
})

describe('MealieMeals — Recipes', () => {
  const open = () => { wrap(); fireEvent.click(screen.getByRole('button', { name: 'Recipes' })) }

  it('debounces search then calls recipes({search})', async () => {
    open()
    await waitFor(() => expect(recipes).toHaveBeenCalledWith({ page: 1 }))
    fireEvent.change(screen.getByPlaceholderText('Search recipes'), { target: { value: 'tac' } })
    fireEvent.change(screen.getByPlaceholderText('Search recipes'), { target: { value: 'taco' } })
    expect(recipes).not.toHaveBeenCalledWith({ search: 'taco', page: 1 })
    await waitFor(() => expect(recipes).toHaveBeenCalledWith({ search: 'taco', page: 1 }))
    expect(recipes).not.toHaveBeenCalledWith({ search: 'tac', page: 1 })
  })

  it('Load more fetches page 2 and appends', async () => {
    recipes.mockResolvedValueOnce({ items: [card('a', 'Alpha')], page: 1, totalPages: 2 })
    recipes.mockResolvedValueOnce({ items: [card('b', 'Beta')], page: 2, totalPages: 2 })
    open()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Beta')
    expect(recipes).toHaveBeenLastCalledWith({ page: 2 })
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('renders a placeholder tile when there is no image', async () => {
    recipes.mockResolvedValue({ items: [card('a', 'Alpha'), card('b', 'Beta', '/img/b.webp')], page: 1, totalPages: 1 })
    open()
    await screen.findByText('Alpha')
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(1))
    expect(document.querySelectorAll('[data-testid="recipe-placeholder"]')).toHaveLength(1)
  })

  it('shows MealieError with Retry when unavailable', async () => {
    recipes.mockRejectedValueOnce(unavailable())
    open()
    expect(await screen.findByText("Can't reach Mealie right now.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(recipes).toHaveBeenCalledTimes(2))
  })
})
