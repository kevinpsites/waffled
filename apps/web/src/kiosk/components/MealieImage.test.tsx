import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../../lib/api/client', () => ({ authFetch: vi.fn() }))

import { authFetch } from '../../lib/api/client'
import { MealieImage } from './MealieImage'

beforeEach(() => {
  vi.mocked(authFetch).mockReset()
  URL.createObjectURL = vi.fn(() => 'blob:abc')
  URL.revokeObjectURL = vi.fn()
})

describe('MealieImage', () => {
  it('renders the placeholder for a null url without fetching', () => {
    render(<MealieImage src={null} />)
    expect(screen.getByTestId('recipe-placeholder')).toBeInTheDocument()
    expect(authFetch).not.toHaveBeenCalled()
  })
  it('fetches with auth and shows the blob url', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(new Blob(['x']), { status: 200 }))
    const { container } = render(<MealieImage src="/api/mealie/images/1/min" />)
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:abc'))
    expect(authFetch).toHaveBeenCalledWith('/api/mealie/images/1/min', {})
  })
  it('falls back to the placeholder when the fetch fails', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response('no', { status: 401 }))
    const { container } = render(<MealieImage src="/api/mealie/images/1/min" />)
    await waitFor(() => expect(screen.getByTestId('recipe-placeholder')).toBeInTheDocument())
    expect(container.querySelector('img')).toBeNull()
  })
  it('revokes the object url on unmount', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(new Blob(['x']), { status: 200 }))
    const { container, unmount } = render(<MealieImage src="/api/mealie/images/1/min" />)
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:abc')
  })
})
