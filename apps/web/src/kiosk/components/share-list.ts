// "Share list" — plain-text formatting for the grocery handoff. Turns the
// board's UNCHECKED items into a phone-friendly text list,
// grouped by aisle in the board's walking order:
//
//   PRODUCE
//   - Asparagus (2 bunch)
//
//   DAIRY & CHILLED
//   - Milk (1 gal)
//
// The same string is copied, shared (navigator.share), and QR-encoded, so a
// phone camera can grab the list with no app or account.

// The canonical aisle walking order — also drives the board's section order and
// the aisle picker in GroceryBoard.
export const AISLE_ORDER = ['Produce', 'Dairy & Chilled', 'Meat & Seafood', 'Pantry', 'Bakery', 'Frozen', 'Other']

// The slice of a grocery-board item the formatter needs (GroceryBoardItem satisfies it).
export interface ShareListItem {
  name: string
  quantity: string | null
  checked: boolean
  aisle: string
}

const OTHER = 'Other'
const line = (i: ShareListItem) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ''}`

/**
 * Unchecked items → grouped plain text ('' when nothing is left to get).
 *
 * Groups are the grocery board's aisles, but any string works — a custom list
 * passes its sections — so this also serves the non-grocery lists. Known aisles
 * lead in walking order, then any unrecognized groups, then the OTHER catch-all
 * last (it is a fallback, so it should never push a real section down the page).
 *
 * A list with NO grouping at all comes out as a flat list with no headers: a lone
 * "OTHER" over every line is noise, and custom lists frequently have no sections.
 */
export function formatShareList(items: ShareListItem[]): string {
  const byGroup = new Map<string, ShareListItem[]>()
  let anyGrouped = false
  for (const i of items) {
    if (i.checked) continue
    if (i.aisle) anyGrouped = true
    const group = i.aisle || OTHER // group-less (hand-added) items read fine under OTHER
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group)!.push(i)
  }

  const all = [...byGroup.values()].flat()
  if (!all.length) return ''
  // Nothing carried a section — headers would add nothing to read.
  if (!anyGrouped) return all.map(line).join('\n')

  const known = AISLE_ORDER.filter((a) => a !== OTHER && byGroup.has(a))
  const unknown = [...byGroup.keys()].filter((a) => a !== OTHER && !AISLE_ORDER.includes(a))
  const ordered = [...known, ...unknown, ...(byGroup.has(OTHER) ? [OTHER] : [])]

  return ordered
    .map((group) => `${group.toUpperCase()}\n${byGroup.get(group)!.map(line).join('\n')}`)
    .join('\n\n')
}
