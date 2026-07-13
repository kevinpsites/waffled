// AI recipe import modals — used from the recipe editor's paste-bar. Both turn some
// input (photos of a physical recipe / a free-form spoken or typed description) into
// the same ParsedRecipe draft the editor prefills from, then hand it back via onDraft.
// Nothing is saved here — the user reviews the filled form and saves as normal.
import { useRef, useState } from 'react'
import { mealsApi, type ParsedRecipe } from '../../lib/api/meals'
import { encodeImageForUpload } from '../../lib/api/media'
import { ApiSendError } from '../../lib/api/client'

const MAX_PHOTOS = 6

function errMessage(e: unknown): string {
  if (e instanceof ApiSendError) return e.body?.message || 'That didn’t work — please try again.'
  return e instanceof Error ? e.message : 'That didn’t work — please try again.'
}

interface EncodedPhoto {
  data: string
  contentType: string
  preview: string // data: URL for the thumbnail
}

// ── Photo(s) → recipe ────────────────────────────────────────────────────────
export function PhotoImportModal({ onClose, onDraft }: { onClose: () => void; onDraft: (p: ParsedRecipe) => void }) {
  const [photos, setPhotos] = useState<EncodedPhoto[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function addFiles(files: FileList | null) {
    if (!files?.length) return
    setErr(null)
    const room = MAX_PHOTOS - photos.length
    const chosen = Array.from(files).slice(0, room)
    const encoded: EncodedPhoto[] = []
    for (const f of chosen) {
      try {
        const { data, contentType } = await encodeImageForUpload(f)
        encoded.push({ data, contentType, preview: `data:${contentType};base64,${data}` })
      } catch (e) {
        setErr(errMessage(e))
      }
    }
    if (encoded.length) setPhotos((prev) => [...prev, ...encoded])
    if (fileRef.current) fileRef.current.value = '' // allow re-picking the same file
  }

  async function extract() {
    if (!photos.length || busy) return
    setBusy(true)
    setErr(null)
    try {
      const draft = await mealsApi.ingestPhoto(photos.map((p) => ({ data: p.data, contentType: p.contentType })))
      onDraft(draft)
      onClose()
    } catch (e) {
      setErr(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Import from a photo</div>
        <p className="tiny muted" style={{ marginTop: 0, marginBottom: 14 }}>
          Snap or choose a photo of a recipe card, cookbook page, or handwritten note — even a few pages of one recipe.
          We’ll read it and fill the form. Photos are held briefly, then deleted.
        </p>

        {photos.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {photos.map((p, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={p.preview} alt="" style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', border: 0, background: 'rgba(0,0,0,.65)', color: '#fff', cursor: 'pointer', lineHeight: 1 }}
                >×</button>
              </div>
            ))}
          </div>
        )}

        {photos.length < MAX_PHOTOS && (
          // Empty state: a single centered, roomy primary button is the one clear
          // action. Once photos are added it demotes to a small ghost "Add another"
          // and the Cancel/Read footer appears.
          <div style={photos.length === 0 ? { display: 'flex', justifyContent: 'center', padding: '6px 0 2px' } : undefined}>
            <label
              className={photos.length === 0 ? 'btn btn-primary' : 'btn btn-ghost'}
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, ...(photos.length === 0 ? { padding: '14px 30px', fontSize: 16 } : {}) }}
            >
              📷 {photos.length ? 'Add another' : 'Choose photos'}
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                capture="environment"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => addFiles(e.target.files)}
              />
            </label>
          </div>
        )}

        {err && <div className="tiny" style={{ color: 'var(--danger,#c0392b)', fontWeight: 700, marginTop: 10 }}>{err}</div>}

        {photos.length > 0 && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--hair)' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={extract}>
              {busy ? 'Reading…' : `Read ${photos.length} → fill the form`}
            </button>
          </div>
        )}
        <p className="tiny muted" style={{ marginBottom: 0, marginTop: 12, textAlign: photos.length === 0 ? 'center' : undefined }}>Under 10&nbsp;MB each · up to {MAX_PHOTOS} photos.</p>
      </div>
    </div>
  )
}

// ── Speech / free-form text → recipe ─────────────────────────────────────────
// Minimal shape of the Web Speech API (no lib types); feature-detected below.
interface SpeechRec {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

function getSpeechRecognition(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function DescribeImportModal({ onClose, onDraft }: { onClose: () => void; onDraft: (p: ParsedRecipe) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRec | null>(null)
  const baseRef = useRef('') // text captured before the current dictation started
  const speechAvailable = !!getSpeechRecognition()

  function toggleMic() {
    if (listening) {
      recRef.current?.stop()
      return
    }
    const Ctor = getSpeechRecognition()
    if (!Ctor) return
    const rec = new Ctor()
    recRef.current = rec
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    baseRef.current = text ? text.trimEnd() + ' ' : ''
    rec.onresult = (e) => {
      let out = ''
      for (let i = 0; i < e.results.length; i++) out += e.results[i][0].transcript
      setText(baseRef.current + out)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    rec.start()
    setListening(true)
  }

  async function submit() {
    if (!text.trim() || busy) return
    if (listening) recRef.current?.stop()
    setBusy(true)
    setErr(null)
    try {
      const draft = await mealsApi.ingestVoice(text)
      onDraft(draft)
      onClose()
    } catch (e) {
      setErr(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Describe the recipe</div>
        <p className="tiny muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Just say or type what you know — ingredients and steps, in any order. We’ll organize it into a recipe you can tidy up.
        </p>

        <label className="field">
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>What’s in it &amp; how to make it</span>
            {speechAvailable && (
              <button
                type="button"
                className="pill"
                onClick={toggleMic}
                style={listening ? { background: 'var(--danger)', color: '#fff', border: 0 } : undefined}
              >
                {listening ? '● Listening… tap to stop' : '🎤 Dictate'}
              </button>
            )}
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            autoFocus
            placeholder="Grandma’s chili — brown a pound of ground beef with an onion, add two cans of kidney beans, a can of diced tomatoes, chili powder and cumin, simmer about 30 minutes…"
          />
        </label>

        {err && <div className="tiny" style={{ color: 'var(--danger,#c0392b)', fontWeight: 700, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? 'Thinking…' : 'Turn into a recipe'}
          </button>
        </div>
      </div>
    </div>
  )
}
