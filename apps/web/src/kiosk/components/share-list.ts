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

// The slice of a list item the formatter needs (GroceryBoardItem satisfies it).
export interface ShareListItem {
  name: string
  quantity: string | null
  checked: boolean
  aisle: string
  /** Where to buy it, when the household has assigned a store. */
  store?: string | null
  /** Who the item is for, when it's assigned to someone. */
  assignee?: string | null
}

const OTHER = 'Other'

// Store and assignee are the two things a shopper needs that the name doesn't
// carry — which shop, and whose it is. Both are usually unset, so an item only
// gains a trailing note when the household actually filled one in.
//
// Bracketed, NOT dash-separated: item names already use an em dash for allergen
// warnings ("Shredded mozzarella — contains milk"), so a dash here would read as
// more of the name. Brackets stay unambiguous next to one.
// The item text itself, without any bullet — both output formats prefix their own.
const itemText = (i: ShareListItem): string => {
  const notes = [i.store, i.assignee].map((v) => v?.trim()).filter(Boolean)
  const qty = i.quantity ? ` (${i.quantity})` : ''
  return `${i.name}${qty}${notes.length ? ` [${notes.join(' · ')}]` : ''}`
}

const line = (i: ShareListItem): string => `- ${itemText(i)}`

// Bucket the UNCHECKED items by group and put the groups in walking order: known
// aisles first, then any unrecognized groups, then the OTHER catch-all last (it is
// a fallback, so it should never push a real section down the page).
//
// `anyGrouped` reports whether any item carried a real section — a list with none
// renders flat, because a lone "Other" header over every line is noise and custom
// lists frequently have no sections at all.
function groupForShare(items: ShareListItem[]): { ordered: string[]; byGroup: Map<string, ShareListItem[]>; anyGrouped: boolean } {
  const byGroup = new Map<string, ShareListItem[]>()
  let anyGrouped = false
  for (const i of items) {
    if (i.checked) continue
    if (i.aisle) anyGrouped = true
    const group = i.aisle || OTHER // group-less (hand-added) items read fine under OTHER
    if (!byGroup.has(group)) byGroup.set(group, [])
    byGroup.get(group)!.push(i)
  }

  const known = AISLE_ORDER.filter((a) => a !== OTHER && byGroup.has(a))
  const unknown = [...byGroup.keys()].filter((a) => a !== OTHER && !AISLE_ORDER.includes(a))
  const ordered = [...known, ...unknown, ...(byGroup.has(OTHER) ? [OTHER] : [])]
  return { ordered, byGroup, anyGrouped }
}

// Shared skeleton for both output formats: same items, same grouping, same order —
// only the per-line and per-header syntax differs. Keeping one code path is what
// stops the plain-text and Markdown shares from drifting apart.
function renderShare(
  items: ShareListItem[],
  renderLine: (i: ShareListItem) => string,
  renderHeader: (group: string) => string
): string {
  const { ordered, byGroup, anyGrouped } = groupForShare(items)
  const all = ordered.flatMap((g) => byGroup.get(g)!)
  if (!all.length) return ''
  if (!anyGrouped) return all.map(renderLine).join('\n')
  return ordered
    .map((group) => `${renderHeader(group)}\n${byGroup.get(group)!.map(renderLine).join('\n')}`)
    .join('\n\n')
}

/**
 * Unchecked items → grouped plain text ('' when nothing is left to get).
 *
 * Groups are the grocery board's aisles, but any string works — a custom list
 * passes its sections — so this also serves the non-grocery lists.
 *
 * This is the string that is copied, shared, and QR-encoded; keep it byte-stable.
 */
export function formatShareList(items: ShareListItem[]): string {
  return renderShare(items, line, (group) => group.toUpperCase())
}

/**
 * The same list as a Markdown checklist ('' when nothing is left to get) — for
 * pasting into a notes app that renders `- [ ]` as a real, tickable checkbox.
 *
 * Only UNCHECKED items are emitted, exactly as in the plain-text share: the export
 * is the shopping list, and an item already in the cart is not part of it. Every
 * box therefore ships unticked, and `- [x]` never appears.
 *
 * Headers keep their natural casing here rather than the plain-text SHOUT: `##`
 * already renders as a heading, so uppercasing only adds noise.
 */
export function formatShareListMarkdown(items: ShareListItem[]): string {
  return renderShare(items, (i) => `- [ ] ${itemText(i)}`, (group) => `## ${group}`)
}
