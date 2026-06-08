// Static family avatars from the design. Becomes real persons (avatar_emoji +
// color) once the kiosk reads /api/persons.
export const AVATARS: Record<string, string> = {
  kevin: '🐻',
  kelly: '🦊',
  wally: '🐢',
  lottie: '🦄',
}

export function Avatar({ person, size = 'md' }: { person: string; size?: 'sm' | 'md' | 'lg' }) {
  return <div className={`av ${person} ${size}`}>{AVATARS[person]}</div>
}
