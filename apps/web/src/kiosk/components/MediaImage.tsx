import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { isSignedMediaURL } from '../../lib/api/media-recovery'

/** Bounded recovery for an image that was fetched after its signed URL expired.
 * Browsers do not expose <img> response status, so a signed-image error refreshes
 * its parent once. A second failure stays visible and offers an explicit retry. */
export function MediaImage({ src, refresh, showRetry = false, ...props }: ImgHTMLAttributes<HTMLImageElement> & {
  refresh: () => Promise<string | null | undefined>
  showRetry?: boolean
}) {
  const [current, setCurrent] = useState(src)
  const [failed, setFailed] = useState(false)
  const attempted = useRef(false)
  const generation = useRef(0)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    generation.current += 1
    attempted.current = false
    setCurrent(src)
    setFailed(false)
    return () => { generation.current += 1 }
  }, [src])

  async function recover(manual = false) {
    if (!src || !isSignedMediaURL(src)) return
    if (attempted.current && !manual) { setFailed(true); return }
    attempted.current = true
    const request = generation.current
    try {
      const next = await refresh()
      if (generation.current !== request) return
      if (!next || (!manual && next === current)) { setFailed(true); return }
      setCurrent(next)
      setAttempt(n => n + 1)
      setFailed(false)
    } catch {
      if (generation.current === request) setFailed(true)
    }
  }

  if (failed) return <span role="status" className={[props.className, "tiny muted"].filter(Boolean).join(" ")}
    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: props.width, height: props.height, ...props.style }}>
    Image unavailable. {showRetry && <button type="button" className="btn btn-ghost" onClick={e => {
      e.stopPropagation(); void recover(true)
    }}>Retry image</button>}
  </span>
  return <img {...props} key={attempt} src={current} onError={() => { void recover() }} />
}
