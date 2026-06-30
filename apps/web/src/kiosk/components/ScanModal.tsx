import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import { pantryApi, ALLERGEN_LABELS, type OffProduct, type PantryItemInput } from '../../lib/api'

// Barcode scan-into-pantry. Uses the device camera (zxing decoder, which works in
// Chrome/Edge/Android and Safari/iOS) to read a barcode, looks it up via Open Food
// Facts, and adds it — then keeps scanning for a rapid stocking loop.
//
// The camera needs a SECURE CONTEXT (https or localhost). On a plain-http LAN origin
// window.isSecureContext is false and getUserMedia is blocked, so we surface a clear
// warning and fall back to typing the barcode. (HTTPS is a documented requirement.)
export function ScanModal({ locations, onClose, onAdded }: { locations: string[]; onClose: () => void; onAdded: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const acceptRef = useRef(true) // gate: stop accepting scans while a result is shown
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })

  const secure = typeof window !== 'undefined' && window.isSecureContext
  const [camErr, setCamErr] = useState<'secure' | 'nocam' | null>(secure ? null : 'secure')
  const [found, setFound] = useState<OffProduct | null | undefined>(undefined) // undefined = scanning
  const [code, setCode] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [name, setName] = useState('')
  const [location, setLocation] = useState(locations[0] ?? 'Pantry')
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(0)

  async function handleCode(raw: string) {
    if (!acceptRef.current) return
    const c = raw.replace(/\D/g, '')
    const now = Date.now()
    if (!c || (c === lastRef.current.code && now - lastRef.current.at < 4000)) return
    lastRef.current = { code: c, at: now }
    acceptRef.current = false
    setCode(c)
    const p = await pantryApi.lookup(c)
    if (p) { setFound(p); setName(p.name ?? '') } else { setFound(null); setName('') }
  }

  // Start the camera decoder once (cleanup stops the stream).
  useEffect(() => {
    if (!secure) return
    let cancelled = false
    const reader = new BrowserMultiFormatReader()
    reader
      .decodeFromVideoDevice(undefined, videoRef.current!, (result) => { if (result && !cancelled) void handleCode(result.getText()) })
      .then((c) => { if (cancelled) c.stop(); else controlsRef.current = c })
      .catch(() => setCamErr('nocam'))
    return () => { cancelled = true; controlsRef.current?.stop() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function resume() { setFound(undefined); setCode(null); setName(''); setAmount('1'); acceptRef.current = true }

  async function add() {
    if (busy) return
    setBusy(true)
    const input: PantryItemInput = { name: name.trim() || 'Item', amount: amount.trim(), location }
    if (found) Object.assign(input, {
      barcode: found.barcode, brand: found.brand, imageUrl: found.imageUrl, quantityText: found.quantityText,
      servingBasis: found.servingBasis, nutrition: found.nutrition, allergens: found.allergens, dietary: found.dietary, source: found.source,
    })
    else if (code) input.barcode = code
    try { await pantryApi.create(input); setAdded((n) => n + 1); onAdded(); resume() } finally { setBusy(false) }
  }

  async function lookupManual() {
    const c = manual.replace(/\D/g, '')
    if (!c) return
    setManual('')
    acceptRef.current = true
    await handleCode(c)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card pl-scan" onClick={(e) => e.stopPropagation()}>
        <div className="pl-scan-head">
          <span className="nk-serif pl-scan-title">Scan into pantry</span>
          {added > 0 && <span className="pl-scan-count">✓ {added} added</span>}
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="pl-scan-body">
          <div className="pl-scan-cam">
            {camErr ? (
              <div className="pl-scan-warn">
                <div className="pl-scan-warn-h">📷 Camera unavailable</div>
                <div className="pl-scan-warn-t">
                  {camErr === 'secure'
                    ? 'The camera needs a secure connection (HTTPS, or localhost on this computer). On a plain http:// address it’s blocked by the browser — type the barcode instead.'
                    : 'Couldn’t start the camera (permission denied or no camera). Type the barcode instead.'}
                </div>
              </div>
            ) : (
              <video ref={videoRef} className="pl-scan-video" muted playsInline />
            )}
            <div className="pl-scan-manual">
              <input value={manual} placeholder="Type a barcode" inputMode="numeric"
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookupManual() } }} />
              <button type="button" className="pill" disabled={!manual.trim()} onClick={lookupManual}>Look up</button>
            </div>
          </div>

          <div className="pl-scan-result">
            {found === undefined && <div className="pl-scan-idle">{camErr ? 'Type a barcode to look it up.' : 'Point the camera at a barcode…'}</div>}

            {found !== undefined && (
              <>
                {found ? (
                  <>
                    <div className="pl-scan-prod">
                      {found.source === 'openfoodfacts' && <span className="pl-off-tag">● Open Food Facts</span>}
                      {found.imageUrl ? <img className="pl-scan-prodimg" src={found.imageUrl} alt="" /> : <span className="pl-scan-prodemoji">🥫</span>}
                      <div className="pl-scan-prodname">{found.name}</div>
                      {found.brand && <div className="pl-scan-prodbrand">{found.brand}</div>}
                      {found.allergens.length > 0 && (
                        <div className="pl-scan-allergens">{found.allergens.map((a) => <span key={a} className="pl-contains-chip">{ALLERGEN_LABELS[a] ?? a}</span>)}</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="pl-scan-prod">
                    <div className="pl-scan-prodname">Not in Open Food Facts</div>
                    <div className="pl-scan-prodbrand">Barcode {code} — name it and add manually.</div>
                    <input className="pl-scan-nameinput" value={name} autoFocus placeholder="Item name" onChange={(e) => setName(e.target.value)} />
                  </div>
                )}

                <div className="pl-scan-fields">
                  <label><span>Where</span>
                    <select value={location} onChange={(e) => setLocation(e.target.value)}>{locations.map((l) => <option key={l} value={l}>{l}</option>)}</select>
                  </label>
                  <label><span>Amount</span>
                    <input value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </label>
                </div>

                <div className="pl-scan-acts">
                  <button type="button" className="pill" disabled={busy} onClick={resume}>Cancel</button>
                  <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={busy || (!found && !name.trim())} onClick={add}>
                    {busy ? 'Adding…' : 'Add & scan next'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="pl-scan-foot">
          <button type="button" className="pill" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
