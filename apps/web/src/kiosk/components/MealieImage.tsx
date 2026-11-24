// Mealie recipe image. The route is bearer-authed, which a plain <img src> can't send,
// so fetch it with the app's auth and show it from an object URL.
import { useEffect, useState, type CSSProperties } from 'react'
import { authFetch } from '../../lib/api/client'

export function MealieImage({ src, className, style, placeholderClassName, placeholderStyle }: {
  src: string | null | undefined
  className?: string
  style?: CSSProperties
  placeholderClassName?: string
  placeholderStyle?: CSSProperties
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setBlobUrl(null)
    setFailed(false)
    if (!src) return
    let alive = true
    let made: string | null = null
    authFetch(src, {})
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (!alive) return
        made = URL.createObjectURL(blob)
        setBlobUrl(made)
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [src])

  if (!src || !blobUrl || failed) {
    return <div className={placeholderClassName ?? className} data-testid="recipe-placeholder" style={placeholderStyle ?? style} />
  }
  return <img src={blobUrl} alt="" className={className} style={style} onError={() => setFailed(true)} />
}
