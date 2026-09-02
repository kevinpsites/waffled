import type { ListItem } from '../../lib/api'

// Free-text search over list rows, shared by the custom-list view and the grocery
// board so "search this list" means one thing everywhere — including on iOS, whose
// `ListDetailModel.matches` (ListDetailView.swift) matches the same way.
//
// The fields matched are the ones the row CARRIES and the user authored: its name,
// whatever header it sits under (a custom list's section, a grocery row's aisle), its
// quantity, and the store on a grocery row. Not every one of them is on screen in
// every view — By-priority flattens the section headers away, and a custom list has
// no store field at all (so that clause simply never fires there) — but each is
// something the user typed or chose, which is what makes a hit explainable.
//
// A blank or whitespace-only query means "no filter", never "match nothing".
export function filterListItems<T extends ListItem & { aisle?: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  const hit = (v: string | null | undefined) => !!v && v.toLowerCase().includes(q)
  return items.filter((i) => hit(i.name) || hit(i.section) || hit(i.aisle) || hit(i.quantity) || hit(i.store))
}
