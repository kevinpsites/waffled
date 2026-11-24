import { render, screen } from '@testing-library/react'
import { ApiSendError } from '../../lib/api/client'
import { MealieError } from './MealieError'

const err = (status: number, error?: string) => new ApiSendError('GET', '/x', status, error ? { error, message: 'x' } : {})
const msg = (e: unknown) => { render(<MealieError error={e} onRetry={() => {}} compact />); return screen.getByText(/./).textContent }

describe('MealieError copy', () => {
  it('not connected', () => expect(msg(err(409, 'MealieNotConnected'))).toBe("Mealie isn't connected. An admin can connect it in Settings → Mealie."))
  it('not found', () => expect(msg(err(404))).toBe("That recipe isn't in Mealie anymore."))
  it('unavailable', () => expect(msg(err(502, 'MealieUnavailable'))).toBe("Can't reach Mealie right now."))
})
