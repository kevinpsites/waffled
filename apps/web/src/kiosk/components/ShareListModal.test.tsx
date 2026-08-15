import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShareListModal } from './ShareListModal'
import QRCode from 'qrcode'

// The QR renderer needs a real canvas — stub it; we assert on WHAT gets encoded
// and on the sizing decision. `create` reports the module count the modal uses to
// decide whether a readable code is even possible; 25 modules is comfortably
// scannable at the 320px display size.
vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,QR'),
    create: vi.fn(() => ({ modules: { size: 25 } })),
  },
}))

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

  // A QR that renders but can't be read is worse than no QR: it looks like the
  // feature works. The modal measures the code first and only draws one it can
  // stand behind.
  it('draws the QR big, at device resolution, with a real quiet zone and low EC', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    render(<ShareListModal items={items} onClose={() => {}} />)

    expect(QRCode.toDataURL).toHaveBeenCalledWith(
      EXPECTED_TEXT,
      expect.objectContaining({ width: 640, margin: 4, errorCorrectionLevel: 'L' })
    )
    const img = await screen.findByAltText('Scan to grab the list')
    expect(img).toHaveAttribute('width', '320')
  })

  it('says the list is too long to scan instead of drawing an unreadable code', async () => {
    // 129 modules at 320px is 2.48 px/module — the real 45-item case.
    vi.mocked(QRCode.create).mockReturnValueOnce({ modules: { size: 129 } } as unknown as ReturnType<typeof QRCode.create>)
    render(<ShareListModal items={items} onClose={() => {}} />)

    expect(await screen.findByText(/too long to scan/i)).toBeInTheDocument()
    expect(screen.queryByAltText('Scan to grab the list')).toBeNull()
    expect(QRCode.toDataURL).not.toHaveBeenCalled()
    // The paths that always work are still offered.
    expect(screen.getByRole('button', { name: 'Copy list' })).toBeInTheDocument()
  })

  it('still shows the list text when the QR is skipped', () => {
    vi.mocked(QRCode.create).mockReturnValueOnce({ modules: { size: 129 } } as unknown as ReturnType<typeof QRCode.create>)
    render(<ShareListModal items={items} onClose={() => {}} />)
    const block = document.querySelector('.share-list-text') as HTMLElement
    expect(block.textContent).toBe(EXPECTED_TEXT)
  })

  // Markdown is a second copy target, not a replacement: the QR and the plain
  // "Copy list" handoff keep emitting the exact same bytes they always have.
  describe('copy as Markdown', () => {
    const EXPECTED_MD = [
      '## Produce',
      '- [ ] Asparagus (2 bunch)',
      '- [ ] Tomatoes (2)',
      '',
      '## Dairy & Chilled',
      '- [ ] Milk (1 gal)',
      '',
      '## Other',
      '- [ ] Cookies',
    ].join('\n')

    it('copies the list as a Markdown checklist', async () => {
      const writeText = stubClipboard()
      render(<ShareListModal items={items} onClose={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }))
      expect(writeText).toHaveBeenCalledWith(EXPECTED_MD)
      expect(await screen.findByText('Copied ✓')).toBeInTheDocument()
    })

    it('leaves the plain-text copy and the QR payload untouched', async () => {
      const writeText = stubClipboard()
      render(<ShareListModal items={items} onClose={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy list' }))
      expect(writeText).toHaveBeenCalledWith(EXPECTED_TEXT)
      expect(QRCode.toDataURL).toHaveBeenCalledWith(EXPECTED_TEXT, expect.anything())
    })

    it('is not offered when there is nothing left to get', () => {
      render(<ShareListModal items={[items[4]]} onClose={() => {}} />)
      expect(screen.queryByRole('button', { name: 'Copy as Markdown' })).not.toBeInTheDocument()
    })
  })
})
