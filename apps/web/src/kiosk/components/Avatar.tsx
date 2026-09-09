// Static family avatars from the design; real persons come from /api/persons.
export const AVATARS: Record<string, string> = {
  kevin: '🐻',
  kelly: '🦊',
  wally: '🐢',
  lottie: '🦄',
}

export function Avatar({ person, size = 'md' }: { person: string; size?: 'sm' | 'md' | 'lg' }) {
  return <div className={`av ${person} ${size}`}>{AVATARS[person]}</div>
}

type AvSize = 'sm' | 'md' | 'lg'

/// Whatever a synced person looks like wherever they turn up — only the four fields a face needs.
export interface AvPerson {
  personId?: string | null
  name?: string | null
  avatarEmoji?: string | null
  colorHex?: string | null
}

/// The neutral tint for a person with no colour of their own.
const NO_COLOR = '#A6A29B'

/// A person's colour as a soft background wash. `22` is the alpha suffix every face in the
/// app uses; surfaces with their OWN face element share the colour rule, not the markup.
export const avTint = (colorHex?: string | null): string => `${colorHex ?? NO_COLOR}22`

/// One real person's face — `Avatar` above is the static design one, keyed by name.
export function PersonAv({ person, size = 'sm' }: { person: AvPerson; size?: AvSize }) {
  return (
    <div
      className={`av ${size}`}
      style={{ background: avTint(person.colorHex) }}
      title={person.name ?? undefined}
    >
      {person.avatarEmoji ?? '🙂'}
    </div>
  )
}

/// Overlapping faces for a group. Shows everyone unless given a `max` — a cap belongs to
/// the surface whose layout needs one, not to every list of participants.
export function AvatarStack({ members, max, size = 'sm' }: { members: AvPerson[]; max?: number; size?: AvSize }) {
  if (members.length === 0) return null
  return (
    <div className="avstack">
      {(max == null ? members : members.slice(0, max)).map((m, i) => (
        <PersonAv key={m.personId ?? m.name ?? i} person={m} size={size} />
      ))}
    </div>
  )
}
