import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { qrIsScannable, qrBitmapPx, QR_DISPLAY_PX, QR_ERROR_CORRECTION } from './share-qr'
import { formatShareList, type ShareListItem } from './share-list'

describe('qrIsScannable', () => {
  it('accepts a code with at least 3 CSS px per module', () => {
    expect(qrIsScannable(100, 320)).toBe(true) // 3.2 px/module
    expect(qrIsScannable(21, 320)).toBe(true) // a tiny code
  })

  it('rejects a code whose modules would be sub-3px', () => {
    expect(qrIsScannable(129, 320)).toBe(false) // 2.48 — the 45-item case
    expect(qrIsScannable(129, 160)).toBe(false) // 1.24 — what shipped originally
  })

  it('treats a nonsense module count as unscannable rather than dividing by it', () => {
    expect(qrIsScannable(0)).toBe(false)
    expect(qrIsScannable(Number.NaN)).toBe(false)
  })
})

describe('qrBitmapPx', () => {
  it('scales the bitmap by device pixel ratio so modules land on whole pixels', () => {
    expect(qrBitmapPx(1, 320)).toBe(320)
    expect(qrBitmapPx(2, 320)).toBe(640)
  })

  it('caps absurd ratios and falls back to 1x for a missing one', () => {
    expect(qrBitmapPx(10, 320)).toBe(960) // capped at 3x
    expect(qrBitmapPx(Number.NaN, 320)).toBe(320)
  })
})

// The rules exist to describe real lists, so pin them against real QR output
// rather than only against hand-picked module counts.
const items = (n: number): ShareListItem[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Item number ${i}`, quantity: '2 cups', aisle: 'Produce', checked: false }))

const moduleCountFor = (text: string): number =>
  QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION }).modules.size

describe('real grocery lists', () => {
  it('a normal weekly list stays scannable at the display size', () => {
    expect(qrIsScannable(moduleCountFor(formatShareList(items(20))), QR_DISPLAY_PX)).toBe(true)
  })

  it('a very long list is correctly judged unscannable, so the UI can say so', () => {
    expect(qrIsScannable(moduleCountFor(formatShareList(items(80))), QR_DISPLAY_PX)).toBe(false)
  })
})
