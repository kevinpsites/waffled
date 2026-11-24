// Generic "pick a household member" dialog: big face + name tiles. Escape or a
// backdrop click cancels.
import { useEffect } from 'react'
import { PersonAv } from './Avatar'
import type { Person } from '../../lib/api/persons'

export function PersonPickModal({
  title,
  people,
  onPick,
  onCancel,
}: {
  title: string
  people: Person[]
  onPick: (personId: string) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="wf-serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: 16 }}>{title}</div>
        <div className="person-pick-grid">
          {people.map((p) => (
            <button key={p.id} type="button" className="person-pick-tile" onClick={() => onPick(p.id)}>
              <PersonAv person={{ personId: p.id, name: p.name, avatarEmoji: p.avatarEmoji, colorHex: p.colorHex }} size="lg" />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
