import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ApiSendError } from '../../lib/api/client'

const plan = vi.fn()
const recipes = vi.fn()
vi.mock('../../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/mealie')>()),
  mealieApi: { plan: (...a: unknown[]) => plan(...a), recipes: (...a: unknown[]) => recipes(...a) },
}))
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  useHousehold: () => ({ household: { timezone: 'UTC', weekStart: 'sunday' } }),
}))

import { MealiePlanModal } from './MealiePlanModal'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-24T12:00:00Z'))
  plan.mockReset().mockResolvedValue({ ok: true })
  recipes.mockReset().mockResolvedValue({ items: [{ id: 'r9', slug: 'soup', name: 'Soup', imageUrl: null, totalTime: null, description: null }], page: 1, totalPages: 1 })
})
afterEach(() => { vi.useRealTimers() })

describe('MealiePlanModal', () => {
  it('offers 14 day chips from the household today', () => {
    render(<MealiePlanModal onClose={() => {}} />)
    const chips = document.querySelectorAll('[data-day]')
    expect(chips).toHaveLength(14)
    expect(chips[0].getAttribute('data-day')).toBe('2026-11-24')
    expect(chips[13].getAttribute('data-day')).toBe('2026-12-07')
  })

  it('posts a preselected recipe as dinner on today by default', async () => {
    const onClose = vi.fn()
    render(<MealiePlanModal recipe={{ id: 'r1', name: 'Tacos' }} onClose={onClose} />)
    expect(screen.getByText('Tacos')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(plan).toHaveBeenCalledWith({ date: '2026-11-24', entryType: 'dinner', recipeId: 'r1' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('posts a typed title with the chosen day and meal type', async () => {
    render(<MealiePlanModal onClose={() => {}} />)
    fireEvent.click(document.querySelector('[data-day="2026-11-26"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Lunch' }))
    fireEvent.change(screen.getByPlaceholderText('Or type a title'), { target: { value: 'Leftovers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(plan).toHaveBeenCalledWith({ date: '2026-11-26', entryType: 'lunch', title: 'Leftovers' }))
  })

  it('picks a recipe from a Mealie search', async () => {
    render(<MealiePlanModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Search Mealie recipes'), { target: { value: 'soup' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Soup' }))
    expect(recipes).toHaveBeenCalledWith({ search: 'soup' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(plan).toHaveBeenCalledWith({ date: '2026-11-24', entryType: 'dinner', recipeId: 'r9' }))
  })

  it('shows a Mealie outage in recipe search instead of empty results', async () => {
    recipes.mockRejectedValue(new ApiSendError('GET', '/x', 502, { error: 'MealieUnavailable', message: 'x' }))
    render(<MealiePlanModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Search Mealie recipes'), { target: { value: 'soup' } })
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach Mealie right now.")
  })

  it('disables Save with neither a recipe nor a title', () => {
    render(<MealiePlanModal onClose={() => {}} />)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a server error inline and stays open', async () => {
    plan.mockRejectedValue(new ApiSendError('POST', '/x', 502, { error: 'MealieUnavailable', message: 'x' }))
    const onClose = vi.fn()
    render(<MealiePlanModal recipe={{ id: 'r1', name: 'Tacos' }} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain("Can't reach Mealie")
    expect(onClose).not.toHaveBeenCalled()
  })
})
