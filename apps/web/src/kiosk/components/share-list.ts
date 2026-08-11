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

/** Unchecked items → aisle-grouped plain text ('' when nothing is left to get). */
export function formatShareList(items: ShareListItem[]): string {
  const byAisle = new Map<string, ShareListItem[]>()
  for (const i of items) {
    if (i.checked) continue
    const aisle = i.aisle || 'Other' // aisle-less (hand-added) items read fine under OTHER
    if (!byAisle.has(aisle)) byAisle.set(aisle, [])
    byAisle.get(aisle)!.push(i)
  }
  const ordered = [
    ...AISLE_ORDER.filter((a) => byAisle.has(a)),
    ...[...byAisle.keys()].filter((a) => !AISLE_ORDER.includes(a)),
  ]
  return ordered
    .map((aisle) => {
      const lines = byAisle.get(aisle)!.map((i) => `- ${i.name}${i.quantity ? ` (${i.quantity})` : ''}`)
      return `${aisle.toUpperCase()}\n${lines.join('\n')}`
    })
    .join('\n\n')
}
