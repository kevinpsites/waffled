import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { ApiSendError } from '../lib/api/client'

const recipe = vi.fn()
vi.mock('../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../lib/api/mealie')>()),
  mealieApi: { recipe: (...a: unknown[]) => recipe(...a), plan: vi.fn(), recipes: vi.fn() },
}))
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  useHousehold: () => ({ household: { timezone: 'UTC', weekStart: 'sunday' } }),
}))

import { MealieRecipe } from './MealieRecipe'

const detail = {
  id: 'r1', slug: 'tacos', name: 'Tacos', imageUrl: '/img/tacos.webp', description: 'Yum', totalTime: '30 min', recipeYield: '4',
  ingredients: [{ title: 'Filling', display: '1 lb beef' }, { title: null, display: '8 tortillas' }],
  steps: [{ title: null, text: 'Brown the beef' }, { title: null, text: 'Warm tortillas' }],
  mealieUrl: 'https://mealie.example/g/home/r/tacos',
}
const wrap = () => render(<MemoryRouter initialEntries={['/meals/mealie/tacos']}><Routes><Route path="/meals/mealie/:slug" element={<MealieRecipe />} /></Routes></MemoryRouter>)

beforeEach(() => { recipe.mockReset().mockResolvedValue({ recipe: detail }) })

describe('MealieRecipe', () => {
  it('renders ingredients (titles as subheadings) and numbered steps', async () => {
    wrap()
    expect(await screen.findByText('1 lb beef')).toBeTruthy()
    expect(recipe).toHaveBeenCalledWith('tacos')
    expect(screen.getByRole('heading', { name: 'Filling' })).toBeTruthy()
    expect(screen.getByText('8 tortillas')).toBeTruthy()
    const steps = document.querySelectorAll('ol.mealie-steps > li')
    expect(steps).toHaveLength(2)
    expect(steps[0].textContent).toContain('Brown the beef')
  })

  it('links to Mealie in a new tab', async () => {
    wrap()
    const a = (await screen.findByRole('link', { name: /Open in Mealie/ })) as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe(detail.mealieUrl)
    expect(a.getAttribute('target')).toBe('_blank')
  })

  it('opens the plan modal with the recipe preselected', async () => {
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Plan this' }))
    const modal = document.querySelector('.modal-card') as HTMLElement
    expect(modal.textContent).toContain('Tacos')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows MealieError with Retry on failure', async () => {
    recipe.mockRejectedValueOnce(new ApiSendError('GET', '/x', 502, { error: 'MealieUnavailable', message: 'x' }))
    wrap()
    expect(await screen.findByText("Can't reach Mealie right now.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('1 lb beef')).toBeTruthy())
  })
})
