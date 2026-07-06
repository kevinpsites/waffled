import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpotAwardModal } from './SpotAwardModal'
import { rewardsApi, type Currency } from '../../lib/api'

const currencies: Currency[] = [
  { id: 'c1', key: 'stars', label: 'Stars', symbol: '⭐', color: '#f2b01e', isDefault: true, spendable: true, sortOrder: 0 },
]

const people = [
  { id: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' },
  { id: 'p2', name: 'Lottie', avatarEmoji: '🦄', colorHex: '#8A5CF0' },
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(rewardsApi, 'awardSpot').mockResolvedValue({ id: 'ledger1' } as never)
})

describe('SpotAwardModal', () => {
  it('with presetPersonId shows no picker and awards to that person', async () => {
    const onClose = vi.fn()
    render(
      <SpotAwardModal people={[people[0]]} presetPersonId="p1" currencies={currencies} onClose={onClose} />
    )
    // No family picker when preset
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByText('Award stars to Wally')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Award/i }))
    await waitFor(() => expect(rewardsApi.awardSpot).toHaveBeenCalledWith('p1', 5, 'stars', undefined))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('without preset requires a picked person before Award enables, then awards the picked id', async () => {
    const onAwarded = vi.fn()
    render(
      <SpotAwardModal people={people} currencies={currencies} onClose={vi.fn()} onAwarded={onAwarded} />
    )
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()

    const awardBtn = screen.getByRole('button', { name: /^Award/i })
    expect(awardBtn).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: /Lottie/i }))
    expect(awardBtn).toBeEnabled()

    fireEvent.click(awardBtn)
    await waitFor(() => expect(rewardsApi.awardSpot).toHaveBeenCalledWith('p2', 5, 'stars', undefined))
    await waitFor(() => expect(onAwarded).toHaveBeenCalled())
  })

  it('plumbs amount and note through to awardSpot', async () => {
    render(
      <SpotAwardModal people={[people[0]]} presetPersonId="p1" currencies={currencies} onClose={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'so helpful' } })
    fireEvent.click(screen.getByRole('button', { name: /^Award/i }))
    await waitFor(() => expect(rewardsApi.awardSpot).toHaveBeenCalledWith('p1', 12, 'stars', 'so helpful'))
  })
})
