import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ParsedIntent } from '../../lib/capture/parse'

const { resolve, lists, addItem, planSlot } = vi.hoisted(() => ({ resolve: vi.fn(), lists: vi.fn(), addItem: vi.fn(), planSlot: vi.fn() }))
const mealieState = { connected: true, hasShoppingList: true, loading: false, refresh: () => {} }
vi.mock('../../lib/mealie-context', () => ({ useMealie: () => mealieState }))
vi.mock('../../lib/api/mealie', async (orig) => ({ ...(await orig<typeof import('../../lib/api/mealie')>()), mealieApi: { addItem } }))
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    usePersons: () => ({ persons: [], loading: false, error: false }),
    useHousehold: () => ({ household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { id: 'p9', name: 'Kev', isAdmin: true, capabilities: [] }, memberships: [], pendingInvites: [] }),
    can: () => true,
    api: { ...actual.api, resolve, lists, warm: vi.fn().mockResolvedValue(undefined), planSlot, recipes: vi.fn().mockResolvedValue({ recipes: [] }) },
  }
})

import { CaptureBar } from './CaptureBar'

function type(value: string) {
  fireEvent.click(document.querySelector('.capture-trigger') as HTMLElement)
  fireEvent.change(screen.getByLabelText('Add anything') as HTMLTextAreaElement, { target: { value } })
}
const intent = (i: object) => i as unknown as ParsedIntent
async function commitClick() {
  const btn = await screen.findByRole('button', { name: 'Add' })
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(btn)
}
const editChips = async () => {
  fireEvent.click(await screen.findByTitle('Tap to edit', {}, { timeout: 3000 }))
}

beforeEach(() => {
  mealieState.connected = true
  resolve.mockReset(); addItem.mockReset().mockResolvedValue({ ok: true }); planSlot.mockReset()
  lists.mockReset().mockResolvedValue({ lists: [] })
})

describe('CaptureBar with Mealie', () => {
  it('adds a grocery intent to Mealie', async () => {
    resolve.mockResolvedValue({ intent: intent({ kind: 'grocery', name: 'chicken', quantity: '2 lbs' }), via: 'anthropic' })
    render(<CaptureBar />)
    type('2 lbs chicken')
    await commitClick()
    await waitFor(() => expect(addItem).toHaveBeenCalledWith(expect.stringMatching(/^2 lbs chicken$/i)))
  })

  it('hides the Meal chip while connected, shows it otherwise', async () => {
    resolve.mockResolvedValue({ intent: intent({ kind: 'grocery', name: 'milk', quantity: null }), via: 'anthropic' })
    const { unmount } = render(<CaptureBar />)
    type('milk')
    await editChips()
    expect(screen.getByText('🛒 Grocery')).toBeTruthy()
    expect(screen.queryByText('🍽️ Meal')).toBeNull()
    unmount()
    mealieState.connected = false
    render(<CaptureBar />)
    type('milk')
    await editChips()
    expect(screen.getByText('🍽️ Meal')).toBeTruthy()
  })

  it('a meal intent shows the Meals-page hint instead of planning', async () => {
    resolve.mockResolvedValue({ intent: intent({ kind: 'meal', title: 'tacos', date: '2026-11-25', mealType: 'dinner', whenLabel: 'Tue · Dinner' }), via: 'anthropic' })
    render(<CaptureBar />)
    type('tacos for dinner tomorrow')
    await commitClick()
    expect(await screen.findByText(/Plan meals from the Meals page while Mealie is connected\./)).toBeTruthy()
    expect(planSlot).not.toHaveBeenCalled()
  })
})
