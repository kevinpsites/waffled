// Allergen design system: a small colored letter badge per allergen, plus the
// bottom-left key that maps badges → names (matches the pantry mocks). Avoided
// allergens (household avoid-list ∪ per-person) get a red ring.
import { ALLERGEN_KEYS, ALLERGEN_LABELS } from '../../lib/api'

// short letter + color per canonical allergen key.
export const ALLERGEN_BADGE: Record<string, { short: string; bg: string; fg: string }> = {
  gluten: { short: 'G', bg: '#E08A3C', fg: '#fff' },
  milk: { short: 'D', bg: '#4F8FD6', fg: '#fff' },
  soy: { short: 'S', bg: '#3FA45B', fg: '#fff' },
  egg: { short: 'E', bg: '#F0CF52', fg: '#5a4a00' },
  peanut: { short: 'P', bg: '#A9743B', fg: '#fff' },
  tree_nut: { short: 'N', bg: '#C98A3A', fg: '#fff' },
  fish: { short: 'F', bg: '#3FB0A6', fg: '#fff' },
  shellfish: { short: 'C', bg: '#D96E92', fg: '#fff' },
  sesame: { short: 'Se', bg: '#CBB079', fg: '#4a3b1a' },
}

export function AllergenBadge({ allergen, avoid, trace }: { allergen: string; avoid?: boolean; trace?: boolean }) {
  const def = ALLERGEN_BADGE[allergen]
  const color = def?.bg ?? '#8a8a8a'
  // `trace` ("may contain") renders outlined instead of solid, to read lighter than
  // a definite allergen while keeping the same color + red avoid-ring.
  const style = trace
    ? { background: 'transparent', color, border: `1.5px solid ${color}` }
    : { background: color, color: def?.fg ?? '#fff' }
  return (
    <span
      className={`alg-badge${avoid ? ' avoid' : ''}`}
      style={style}
      title={`${ALLERGEN_LABELS[allergen] ?? allergen}${trace ? ' (may contain)' : ''}${avoid ? ' — avoiding' : ''}`}
    >
      {def?.short ?? allergen.slice(0, 2).toUpperCase()}
    </span>
  )
}

// A row of badges for an item's allergens (avoided ones ringed red).
export function AllergenBadges({ allergens, avoid }: { allergens: string[]; avoid: Set<string> }) {
  if (!allergens.length) return null
  return (
    <span className="alg-badges">
      {allergens.map((a) => <AllergenBadge key={a} allergen={a} avoid={avoid.has(a)} />)}
    </span>
  )
}

// The persistent legend (bottom-left). Avoided allergens are ringed so the key also
// shows what the household is avoiding.
export function AllergenKey({ avoid }: { avoid: Set<string> }) {
  return (
    <div className="alg-key">
      <div className="alg-key-h">Allergens</div>
      <div className="alg-key-items">
        {ALLERGEN_KEYS.map((a) => (
          <span key={a} className="alg-key-item">
            <AllergenBadge allergen={a} avoid={avoid.has(a)} />
            <span className="alg-key-name">{ALLERGEN_LABELS[a]}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
