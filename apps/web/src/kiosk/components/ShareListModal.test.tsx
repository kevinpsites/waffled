import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShareListModal } from './ShareListModal'
import QRCode from 'qrcode'

// The QR renderer needs a real canvas — stub it; we assert on WHAT gets encoded.
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }))

// The share view's fixture list: two aisles, an aisle-less item, and a checked
// item that must NOT appear in the shared text.
const items = [
  { name: 'Asparagus', quantity: '2 bunch', aisle: 'Produce', checked: false },
  { name: 'Tomatoes', quantity: '2', aisle: 'Produce', checked: false },
  { name: 'Milk', quantity: '1 gal', aisle: 'Dairy & Chilled', checked: false },
  { name: 'Cookies', quantity: null, aisle: '', checked: false },
  { name: 'Butter', quantity: null, aisle: 'Dairy & Chilled', checked: true },
]

const EXPECTED_TEXT = [
  'PRODUCE',
  '- Asparagus (2 bunch)',
  '- Tomatoes (2)',
  '',
  'DAIRY & CHILLED',
  '- Milk (1 gal)',
  '',
  'OTHER',
  '- Cookies',
].join('\n')

function stubClipboard() {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}
function stubShare() {
  const share = vi.fn(async () => {})
  Object.defineProperty(navigator, 'share', { value: share, configurable: true })
  return share
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(navigator, 'share')
  vi.mocked(QRCode.toDataURL).mockClear()
})

describe('ShareListModal', () => {
  it('renders the unchecked items as a plain-text list grouped by aisle', () => {
    render(<ShareListModal items={items} onClose={() => {}} />)
    expect(screen.getByText('Share list')).toBeInTheDocument()
    const block = document.querySelector('.share-list-text') as HTMLElement
    expect(block).toBeInTheDocument()
    expect(block.textContent).toBe(EXPECTED_TEXT)
  })

  it('copies the formatted text to the clipboard with a visual confirmation', async () => {
    const writeText = stubClipboard()
    render(<ShareListModal items={items} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }))
    expect(writeText).toHaveBeenCalledWith(EXPECTED_TEXT)
    expect(await screen.findByText('Copied ✓')).toBeInTheDocument()
  })

  it('offers navigator.share when the browser supports it', async () => {
    stubClipboard()
    const share = stubShare()
    render(<ShareListModal items={items} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share…' }))
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'Grocery list', text: EXPECTED_TEXT }))
  })

  it('hides the share button when navigator.share is unavailable', () => {
    stubClipboard()
    render(<ShareListModal items={items} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Share…' })).not.toBeInTheDocument()
  })

  it('encodes the plain text (not a URL) into the QR code', async () => {
    render(<ShareListModal items={items} onClose={() => {}} />)
    expect(await screen.findByAltText('Scan to grab the list')).toBeInTheDocument()
    expect(QRCode.toDataURL).toHaveBeenCalledWith(EXPECTED_TEXT, expect.anything())
  })

  it('shows an empty state instead of QR/buttons when everything is checked', () => {
    render(<ShareListModal items={[items[4]]} onClose={() => {}} />)
    expect(screen.getByText(/Nothing to share/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy list' })).not.toBeInTheDocument()
    expect(QRCode.toDataURL).not.toHaveBeenCalled()
  })
})
