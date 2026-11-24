// Generic bottom toast with an Undo button. onDone fires exactly once: on timeout
// or right after Undo, whichever comes first.
import { useEffect, useRef } from 'react'

export function UndoToast({
  message,
  onUndo,
  onDone,
  ms = 6000,
}: {
  message: string
  onUndo: () => void
  onDone: () => void
  ms?: number
}) {
  const finished = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const finish = () => {
    if (finished.current) return
    finished.current = true
    onDoneRef.current()
  }

  useEffect(() => {
    const t = setTimeout(finish, ms)
    return () => clearTimeout(t)
  }, [ms])

  return (
    <div className="undo-toast" role="status">
      <span>{message}</span>
      <button
        type="button"
        className="undo-toast-btn"
        onClick={() => {
          if (finished.current) return
          onUndo()
          finish()
        }}
      >
        Undo
      </button>
    </div>
  )
}
