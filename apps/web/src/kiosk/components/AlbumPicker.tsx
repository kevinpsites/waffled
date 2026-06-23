import { useEffect, useRef, useState } from 'react'

// AlbumPicker — a real <select> of existing albums plus a "＋ New album…" option
// that reveals a text input for typing a brand-new name. Used by both PhotoAdd and
// PhotoDetail in place of the old <input list> + <datalist> (which read like a plain
// text box and hid the existing albums). Controlled: `value` is the chosen/typed
// album name ('' means no album), `onChange` reports every change.

// Sentinel <option> value for "type a new album" — chosen, but never a real album.
const NEW = '__new__'

export function AlbumPicker({
  value,
  onChange,
  albums,
  id,
}: {
  value: string
  onChange: (v: string) => void
  albums: string[]
  id?: string
}) {
  // Show the text input when the user picked "＋ New album…", OR when the current
  // value is a non-empty name that isn't one of the known albums (e.g. a freshly
  // typed name on re-render, or an existing photo whose album was deleted).
  const [typingNew, setTypingNew] = useState(() => !!value && !albums.includes(value))
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the text input the moment it appears (after choosing "＋ New album…").
  useEffect(() => {
    if (typingNew) inputRef.current?.focus()
  }, [typingNew])

  const selectValue = typingNew ? NEW : albums.includes(value) ? value : ''

  function onSelect(v: string) {
    if (v === NEW) {
      setTypingNew(true)
      onChange('') // clear so the text input starts empty
    } else {
      setTypingNew(false)
      onChange(v) // '' = (No album), or an existing album name
    }
  }

  return (
    <div className="album-picker">
      <select id={id} className="field" value={selectValue} onChange={(e) => onSelect(e.target.value)}>
        <option value="">(No album)</option>
        {albums.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
        <option value={NEW}>＋ New album…</option>
      </select>
      {typingNew && (
        <input
          ref={inputRef}
          className="field"
          placeholder="New album name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
