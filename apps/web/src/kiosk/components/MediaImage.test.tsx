import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MediaImage } from './MediaImage'

const oldURL = '/media/family/proof.jpg?expires=100&sig=old'
const freshURL = '/media/family/proof.jpg?expires=200&sig=fresh'

describe('signed media recovery', () => {
  it.each(['Recipe', 'Chore proof'])('refreshes the parent and retries an expired %s image once', async label => {
    const refresh = vi.fn().mockResolvedValue(freshURL)
    render(<MediaImage showRetry src={oldURL} alt={label} refresh={refresh} />)
    fireEvent.error(screen.getByAltText(label))
    await waitFor(() => expect(screen.getByAltText(label)).toHaveAttribute('src', freshURL))
    fireEvent.error(screen.getByAltText(label))
    expect(await screen.findByRole('button', { name: /Retry image/ })).toBeVisible()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not silently retry forever when the refreshed URL is unchanged', async () => {
    const refresh = vi.fn().mockResolvedValue(oldURL)
    render(<MediaImage showRetry src={oldURL} alt="Proof" refresh={refresh} />)
    fireEvent.error(screen.getByAltText('Proof'))
    expect(await screen.findByRole('button', { name: /Retry image/ })).toBeVisible()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('allows an explicit retry with the same URL and bounds its automatic retry', async () => {
    const refresh = vi.fn().mockResolvedValue(oldURL)
    render(<MediaImage showRetry src={oldURL} alt="Proof" refresh={refresh} />)
    fireEvent.error(screen.getByAltText('Proof'))
    fireEvent.click(await screen.findByRole('button', { name: /Retry image/ }))
    expect(await screen.findByAltText('Proof')).toHaveAttribute('src', oldURL)
    fireEvent.error(screen.getByAltText('Proof'))
    expect(await screen.findByRole('button', { name: /Retry image/ })).toBeVisible()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not recover an unsigned external image through household API', () => {
    const refresh = vi.fn()
    render(<MediaImage showRetry src="https://images.example/food.jpg" alt="External" refresh={refresh} />)
    fireEvent.error(screen.getByAltText('External'))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('discards a previous resource refresh after the component changes to another image', async () => {
    let finish!: (url: string) => void
    const refresh = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const { rerender } = render(<MediaImage showRetry src={oldURL} alt="Photo" refresh={refresh} />)
    fireEvent.error(screen.getByAltText('Photo'))
    rerender(<MediaImage showRetry src="/media/family/other.jpg?expires=200&sig=other" alt="Photo" refresh={refresh} />)
    finish(freshURL)
    await waitFor(() => expect(screen.getByAltText('Photo')).toHaveAttribute('src', '/media/family/other.jpg?expires=200&sig=other'))
  })
})
