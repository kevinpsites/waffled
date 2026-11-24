import { ApiSendError } from './client'

vi.mock('./client', async (orig) => ({ ...(await orig<typeof import('./client')>()), apiSend: vi.fn() }))

import { apiSend } from './client'
import { mealieApi, mealieErrorCode } from './mealie'

describe('mealieErrorCode', () => {
  it('reads ApiSendError.body.error', () => {
    expect(mealieErrorCode(new ApiSendError('GET', '/x', 502, { error: 'MealieUnavailable' }))).toBe('MealieUnavailable')
    expect(mealieErrorCode(new ApiSendError('GET', '/x', 409, { error: 'MealieNoShoppingList' }))).toBe('MealieNoShoppingList')
  })
  it('is null for anything else', () => {
    expect(mealieErrorCode(new ApiSendError('GET', '/x', 500, { error: 'Other' }))).toBeNull()
    expect(mealieErrorCode(new Error('boom'))).toBeNull()
    expect(mealieErrorCode(null)).toBeNull()
  })
})

describe('mealieApi', () => {
  beforeEach(() => { vi.mocked(apiSend).mockReset().mockResolvedValue({ ok: true }) })

  it('addItem emits mealie', async () => {
    const seen = vi.fn()
    window.addEventListener('waffled:mealie', seen)
    await mealieApi.addItem('milk')
    window.removeEventListener('waffled:mealie', seen)
    expect(apiSend).toHaveBeenCalledWith('POST', '/api/mealie/shopping/items', { text: 'milk' })
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('reads go through apiSend GET and do not emit', async () => {
    const seen = vi.fn()
    window.addEventListener('waffled:mealie', seen)
    await mealieApi.mealplan('2026-01-01', '2026-01-07')
    await mealieApi.recipes({ search: 'pie', page: 2 })
    window.removeEventListener('waffled:mealie', seen)
    expect(apiSend).toHaveBeenCalledWith('GET', '/api/mealie/mealplan?start=2026-01-01&end=2026-01-07')
    expect(apiSend).toHaveBeenCalledWith('GET', '/api/mealie/recipes?search=pie&page=2')
    expect(seen).not.toHaveBeenCalled()
  })

  it('connection changes emit mealie', async () => {
    const seen = vi.fn()
    window.addEventListener('waffled:mealie', seen)
    await mealieApi.saveConnection({ baseUrl: 'http://m' })
    await mealieApi.disconnect()
    window.removeEventListener('waffled:mealie', seen)
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
