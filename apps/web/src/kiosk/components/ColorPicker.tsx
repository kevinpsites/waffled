import { useEffect, useRef, useState, type CSSProperties } from 'react'

// The eight preset member swatches — shared by the member editor, the own-profile
// card, and the household family-color setting.
export const COLOR_SWATCHES = ['#2F7FED', '#EC6049', '#25A368', '#8B5CF6', '#E0A500', '#EC4899', '#14B8A6', '#6B7280']

const HEX = /^#[0-9a-fA-F]{6}$/

// The preset row plus a ninth "custom" swatch: a native color input hidden behind
// a swatch-sized button, so colors aren't limited to the eight presets.
//
// Dragging around a native color input fires an `input` event per step. Reporting
// each one means the caller saves (and refetches) dozens of times for one drag,
// racing itself and snapping the controlled value back mid-drag — so the drag is
// previewed locally and `onChange` fires once, on the browser's `change` event
// (the color the user settled on). React's own onChange can't tell the two apart,
// hence the native listener.
export function ColorPicker({ value, onChange, size = 30 }: { value: string | null; onChange: (hex: string) => void; size?: number }) {
  const customRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const commitRef = useRef(onChange)
  useEffect(() => {
    commitRef.current = onChange
  })
  // Drop the local preview once the caller's value catches up — holding it until
  // then keeps the swatch from flashing back to the old color while the save and
  // its refetch are in flight.
  useEffect(() => {
    setDragging(null)
  }, [value])
  useEffect(() => {
    const el = customRef.current
    if (!el) return
    const commit = () => commitRef.current(el.value)
    el.addEventListener('change', commit)
    return () => el.removeEventListener('change', commit)
  }, [])

  const shown = dragging ?? value
  const isCustom = !!shown && HEX.test(shown) && !COLOR_SWATCHES.includes(shown)
  const swatch = (c: string, selected: boolean): CSSProperties => ({
    width: size,
    height: size,
    borderRadius: 999,
    background: c,
    border: selected ? '3px solid var(--ink)' : '2px solid #fff',
    boxShadow: '0 0 0 1px var(--hair)',
    cursor: 'pointer',
    padding: 0,
  })
  return (
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
      {COLOR_SWATCHES.map((c) => (
        <button type="button" key={c} aria-label={`color ${c}`} onClick={() => { setDragging(null); onChange(c) }} style={swatch(c, shown === c)} />
      ))}
      <button
        type="button"
        aria-label="Custom color"
        title="Custom color"
        onClick={() => customRef.current?.click()}
        style={{
          ...swatch(isCustom ? (shown as string) : 'conic-gradient(#EC6049, #E0A500, #25A368, #2F7FED, #8B5CF6, #EC6049)', isCustom),
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {!isCustom && (
          <span style={{ color: '#fff', fontWeight: 800, fontSize: size * 0.45, textShadow: '0 1px 2px rgba(0,0,0,.45)', lineHeight: 1 }}>＋</span>
        )}
      </button>
      <input
        ref={customRef}
        type="color"
        aria-label="Pick a custom color"
        value={shown && HEX.test(shown) ? shown : '#888888'}
        onChange={(e) => setDragging(e.target.value)}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  )
}
