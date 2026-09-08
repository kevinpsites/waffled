// Lists domain — client slice, types, and hooks. Backs the Lists screen
// (multiple named lists, sectioned items, assignees) AND the Today dashboard's
// Grocery card (the original grocery exports are kept intact).
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { apiGet, apiSend, apiSendForIdentity, apiDelete } from './client'
import { tap, useRefetchOn, useLiveRefresh } from './bus'

// ---- grocery (Today dashboard) ---------------------------------------------

// A lightweight person reference (assignee / addedBy attribution). Shared by the
// list item types below so the two attribution fields stay in lockstep.
export interface ListItemPersonRef {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
}

export interface GroceryItem {
  id: string
  name: string
  quantity: string | null
  // see ListItem.quantityInput — the typable form, for edit fields
  quantityInput?: string | null
  checked: boolean
  // ambient attribution (see ListItem) — who hand-added it + where it came from
  addedBy?: ListItemPersonRef | null
  source?: string
  sourceRecipeIds?: string[]
  sourceMealIds?: string[]
}

// ---- lists (the Lists screen) ----------------------------------------------

export interface ListSummary {
  id: string
  name: string
  emoji: string | null
  listType: string
  isAutoBuilt: boolean
  sortMode: string
  itemCount: number
}

// A saved list template (a list_type='template' list, hidden from the normal
// rail). Same shape as a list summary — `listType` is always 'template'.
export type ListTemplateSummary = ListSummary

// Kept as an alias for back-compat; the shape is the shared person ref.
export type ListItemAssignee = ListItemPersonRef

export interface ListItem {
  id: string
  name: string
  quantity: string | null
  // `quantity` with fraction glyphs spelled out ("1 1/2 lb" for a displayed "1½ lb").
  // Use it to seed edit fields — a ½ can be read but not typed. Saving it round-trips.
  quantityInput?: string | null
  checked: boolean
  checkedAt: string | null
  section: string | null
  // Free-text store/vendor (Costco, Walmart, …); null = unassigned.
  store?: string | null
  // 1–5 urgency scale: 1 = not urgent, 3 = normal, 5 = urgent. Higher sorts first.
  priority?: number
  sortOrder: number | null
  assignee: ListItemAssignee | null
  // ambient attribution: who hand-added the item, and where it came from.
  // `addedBy` is null for items auto-generated from the meal plan; `source` is
  // one of 'manual' | 'auto' | 'suggested' | 'voice'; `sourceRecipeIds` is
  // non-empty for meal-plan ('auto') items.
  addedBy?: ListItemPersonRef | null
  source?: string
  sourceRecipeIds?: string[]
  // Which Meal Builder plate(s) the row was added for — empty for a plain recipe
  // add or a hand-typed row. Lets the grocery board colour every row of a plate
  // with the plate's own dot instead of one dot per dish.
  sourceMealIds?: string[]
}

export interface ListDetail {
  list: ListSummary | { id: string; name: string; emoji: string | null; listType: string; isAutoBuilt: boolean; sortMode: string }
  items: ListItem[]
}

export interface PatchItemBody {
  checked?: boolean
  assignedTo?: string | null
  quantity?: string | null
  section?: string | null
  store?: string | null
  priority?: number
  name?: string
}

// PATCH /api/list-items uses `category` server-side for the section column.
function patchBody(b: PatchItemBody): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('checked' in b) out.checked = b.checked
  if ('assignedTo' in b) out.assignedTo = b.assignedTo
  if ('quantity' in b) out.quantity = b.quantity
  if ('section' in b) out.category = b.section
  if ('store' in b) out.store = b.store
  if ('priority' in b) out.priority = b.priority
  if ('name' in b) out.name = b.name
  return out
}

export const groceryApi = {
  // grocery (unchanged surface for the Today card)
  grocery: () => apiGet<{ items: GroceryItem[] }>('/api/lists/grocery'),
  addGroceryItem: (name: string) =>
    apiSend<{ item: GroceryItem }>('POST', '/api/lists/grocery/items', { name }).then((r) => r.item).then(tap('grocery')),
  setItemChecked: (id: string, checked: boolean) =>
    apiSend<{ item: GroceryItem }>('PATCH', `/api/list-items/${id}`, { checked }).then((r) => r.item).then(tap('grocery')),
  deleteItem: (id: string) => apiDelete(`/api/list-items/${id}`).then(tap('grocery')),
  // weekStart scopes an off-plan add/remove to the week being shopped (defaults to the
  // current week server-side when omitted, e.g. from a recipe page with no week context).
  // `ingredientIds` (optional) adds only the picked subset — the shopper already has the
  // rest on hand. Omit it to add every non-staple ingredient (the original behavior).
  groceryFromRecipe: (recipeId: string, weekStart?: string, ingredientIds?: string[]) =>
    apiSend<{ added: number }>('POST', `/api/lists/grocery/from-recipe/${recipeId}${weekStart ? `?weekStart=${weekStart}` : ''}`, ingredientIds ? { ingredientIds } : undefined).then(tap('grocery')),
  removeRecipeFromGrocery: (recipeId: string, weekStart?: string) =>
    apiDelete(`/api/lists/grocery/from-recipe/${recipeId}${weekStart ? `?weekStart=${weekStart}` : ''}`).then(tap('grocery')),

  // lists (the Lists screen)
  lists: (identityScope?: string | null) => identityScope === undefined
    ? apiGet<{ lists: ListSummary[] }>('/api/lists')
    : apiSendForIdentity<{ lists: ListSummary[] }>(identityScope, 'GET', '/api/lists'),
  list: (id: string) => apiGet<ListDetail>(`/api/lists/${id}`),
  createList: (input: { name: string; emoji?: string | null }, identityScope?: string | null) =>
    (identityScope === undefined
      ? apiSend<{ list: ListSummary }>('POST', '/api/lists', input)
      : apiSendForIdentity<{ list: ListSummary }>(identityScope, 'POST', '/api/lists', input))
      .then((r) => r.list),
  renameList: (id: string, patch: { name?: string; emoji?: string | null }) =>
    apiSend<{ list: ListSummary }>('PATCH', `/api/lists/${id}`, patch).then((r) => r.list),
  deleteList: (id: string) => apiDelete(`/api/lists/${id}`).then(tap('grocery')),
  // list templates (mark a list as a template — converts in place; move back;
  // apply a template into a fresh list)
  templates: () => apiGet<{ templates: ListTemplateSummary[] }>('/api/lists/templates'),
  saveAsTemplate: (listId: string) =>
    apiSend<{ template: ListTemplateSummary }>('POST', `/api/lists/${listId}/save-as-template`, {}).then((r) => r.template).then(tap('grocery')),
  unmarkTemplate: (id: string) =>
    apiSend<{ list: ListSummary }>('POST', `/api/lists/${id}/unmark-template`, {}).then((r) => r.list).then(tap('grocery')),
  applyTemplate: (templateId: string, name?: string) =>
    apiSend<{ list: ListSummary }>('POST', `/api/lists/templates/${templateId}/apply`, name ? { name } : {}).then((r) => r.list).then(tap('grocery')),

  addListItem: (listId: string, input: { name: string; quantity?: string | null; section?: string | null; store?: string | null; assignedTo?: string | null; priority?: number }, identityScope?: string | null) => {
    const body = {
      name: input.name,
      quantity: input.quantity ?? null,
      category: input.section ?? null,
      ...(input.store !== undefined ? { store: input.store } : {}),
      assignedTo: input.assignedTo ?? null,
      ...(input.priority ? { priority: input.priority } : {}),
    }
    return (identityScope === undefined
      ? apiSend<{ item: ListItem }>('POST', `/api/lists/${listId}/items`, body)
      : apiSendForIdentity<{ item: ListItem }>(identityScope, 'POST', `/api/lists/${listId}/items`, body))
      .then((r) => r.item).then(tap('grocery'))
  },
  patchListItem: (id: string, patch: PatchItemBody) =>
    apiSend<{ item: ListItem }>('PATCH', `/api/list-items/${id}`, patchBody(patch)).then((r) => r.item).then(tap('grocery')),
  // The household's previously-used store names (most-used first) — quick-select for
  // a grocery item's store field.
  stores: () => apiGet<{ stores: string[] }>('/api/lists/stores').then((r) => r.stores),
  // Bulk-edit section/store/assignee/priority across a multi-selection (one round-trip).
  bulkPatchItems: (ids: string[], patch: { section?: string | null; store?: string | null; assignedTo?: string | null; priority?: number }) =>
    apiSend<{ updated: number }>('PATCH', '/api/list-items/bulk', { ids, patch }).then((r) => r.updated).then(tap('grocery')),
  // Clear a custom list's Completed section now (soft-deletes its checked items).
  clearCompleted: (listId: string) =>
    apiSend<{ cleared: number }>('POST', `/api/lists/${listId}/clear-completed`, {}).then((r) => r.cleared).then(tap('grocery')),

  // grocery board (auto-built view) + pantry staples
  groceryBoard: (weekStart?: string) =>
    apiGet<GroceryBoard>(`/api/lists/grocery/board${weekStart ? `?weekStart=${weekStart}` : ''}`),
  rebuildGrocery: (weekStart?: string, identityScope?: string | null) => {
    const path = `/api/lists/grocery/rebuild${weekStart ? `?weekStart=${weekStart}` : ''}`
    return (identityScope === undefined
      ? apiSend<{ rebuilt: number; board: GroceryBoard }>('POST', path)
      : apiSendForIdentity<{ rebuilt: number; board: GroceryBoard }>(identityScope, 'POST', path))
      .then(tap('grocery'))
  },
  // "Start over": un-check everything on the given week's list (Refresh keeps checks).
  clearGroceryChecks: (weekStart?: string) =>
    apiSend<{ cleared: number; board: GroceryBoard }>('POST', `/api/lists/grocery/clear-checks${weekStart ? `?weekStart=${weekStart}` : ''}`).then(tap('grocery')),
  pantryStaples: () => apiGet<{ staples: PantryStaple[] }>('/api/pantry-staples'),
  addStaple: (name: string) => apiSend<{ staple: PantryStaple }>('POST', '/api/pantry-staples', { name }).then((r) => r.staple).then(tap('grocery')),
  removeStaple: (id: string) => apiDelete(`/api/pantry-staples/${id}`).then(tap('grocery')),
}

// One dish on a plate, as the grocery board needs it (the full dish shape lives in
// `mealBuilder.ts` — the board only ever renders a child row).
export interface GroceryMealDish {
  recipeId: string
  title: string | null
  emoji: string | null
  // 'main' | 'side' | 'dessert' today, but free text by design.
  role: string
}

// A planned slot. It holds EITHER a single recipe (`recipeId` set, `mealId` null,
// `recipes` empty) or a whole Meal Builder plate (`mealId` set, `recipes` = its
// dishes) — the board renders the latter as one expandable parent row.
export interface GroceryMeal {
  date: string
  mealType: string
  recipeId: string | null
  mealId?: string | null
  title: string | null
  emoji: string | null
  color: string
  recipes?: GroceryMealDish[]
}
export interface PantryStaple {
  id: string
  name: string
}
// A recipe whose ingredients are on the list but that isn't planned this week
// (added straight from a recipe page) — gets its own by-meal section + dot color.
export interface GroceryUnscheduled {
  recipeId: string
  title: string
  emoji: string | null
  color: string
}
// A plate whose shopping is on the list but that was never scheduled ("Add plate to
// list"). Its dishes are NOT also listed in `unscheduled` — they render as the
// plate's child rows.
export interface GroceryUnscheduledMeal {
  mealId: string
  name: string
  color: string
  recipes: GroceryMealDish[]
}
// The pantry item covering a grocery row — "you already have this". `amount`/`unit` are
// the PANTRY item's own free text ("1" + "bag"), never a comparison against the row's
// quantity: the match is presence-only, so the honest move is to show what's in the house
// and let the shopper judge whether a bag of rice covers the two cups they need.
export interface PantryHit {
  name: string
  amount: string
  unit: string
}
export interface GroceryBoardItem extends ListItem {
  aisle: string
  source: string
  sourceRecipeIds: string[]
  // The week this row belongs to (meal-derived + off-plan rows); null = global manual row.
  weekStart: string | null
  // Non-null ⇒ something on hand matches this row. null ⇒ either nothing matches or the
  // pantry module is off — the client can't tell them apart and doesn't need to: both
  // mean "make no on-hand claim". Optional so a server predating it doesn't break.
  pantry?: PantryHit | null
}
export interface GroceryBoard {
  list: ListSummary
  weekStart: string
  meals: GroceryMeal[]
  unscheduled?: GroceryUnscheduled[]
  unscheduledMeals?: GroceryUnscheduledMeal[]
  items: GroceryBoardItem[]
  staples: PantryStaple[]
}

export interface GroceryBoardState {
  board: GroceryBoard | null
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useGroceryBoard(weekStart?: string): GroceryBoardState {
  const [board, setBoard] = useState<GroceryBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    groceryApi
      .groceryBoard(weekStart)
      .then((d) => alive && (setBoard(d), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [weekStart, nonce])
  // a dinner being planned changes the board's "this week's dinners" + auto items
  useRefetchOn(['grocery', 'meals'], () => setNonce((n) => n + 1))
  // Cross-device liveness: poll + refetch on focus so another family member's edits appear.
  useLiveRefresh(() => setNonce((n) => n + 1))
  return { board, loading, error, refetch: () => setNonce((n) => n + 1) }
}

// ---- grocery hook (Today dashboard) ----------------------------------------

export interface GroceryState {
  items: GroceryItem[]
  loading: boolean
  error: boolean
  add: (name: string) => Promise<void>
  toggle: (id: string, checked: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function useGrocery(): GroceryState {
  const [items, setItems] = useState<GroceryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  // See useListDetail: a poll answer composed before a local edit must not overwrite it.
  const edits = useRef(0)

  useEffect(() => {
    let alive = true
    const startedAt = edits.current
    groceryApi
      .grocery()
      .then((d) => {
        if (alive) {
          if (edits.current === startedAt) setItems(d.items)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [nonce])
  // keep the Today grocery card in sync with edits made on the Lists board, a
  // recipe's "add to grocery", etc.
  useRefetchOn(['grocery'], () => setNonce((n) => n + 1))
  // Cross-device liveness: another family member checking an item shows up here too.
  useLiveRefresh(() => setNonce((n) => n + 1))

  async function add(name: string): Promise<void> {
    const item = await groceryApi.addGroceryItem(name)
    edits.current += 1
    setItems((prev) => [...prev, item])
  }

  // Optimistic toggle; revert on failure.
  async function toggle(id: string, checked: boolean): Promise<void> {
    edits.current += 1
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, checked } : i)))
    try {
      await groceryApi.setItemChecked(id, checked)
    } catch {
      edits.current += 1
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, checked: !checked } : i)))
    }
  }

  // Optimistic removal; restore on failure.
  async function remove(id: string): Promise<void> {
    let snapshot: GroceryItem[] = []
    edits.current += 1
    setItems((prev) => {
      snapshot = prev
      return prev.filter((i) => i.id !== id)
    })
    try {
      await groceryApi.deleteItem(id)
    } catch {
      edits.current += 1
      setItems(snapshot)
    }
  }

  return { items, loading, error, add, toggle, remove }
}

// ---- lists hooks (the Lists screen) ----------------------------------------

export interface ListsState {
  lists: ListSummary[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useLists(): ListsState {
  const [lists, setLists] = useState<ListSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    groceryApi
      .lists()
      .then((d) => alive && (setLists(d.lists), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  // Converting a list to/from a template (and item add/remove) taps 'grocery';
  // refetch so the Lists rail and the Templates group stay in lockstep.
  useRefetchOn(['grocery'], () => setNonce((n) => n + 1))
  // Cross-device liveness: keep the rail counts fresh when another device edits a list.
  useLiveRefresh(() => setNonce((n) => n + 1))
  return { lists, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface TemplatesState {
  templates: ListTemplateSummary[]
  loading: boolean
  error: boolean
  refetch: () => void
}

// The household's saved list templates (for the "Apply a template" picker).
export function useTemplates(): TemplatesState {
  const [templates, setTemplates] = useState<ListTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    groceryApi
      .templates()
      .then((d) => alive && (setTemplates(d.templates), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  useRefetchOn(['grocery'], () => setNonce((n) => n + 1))
  return { templates, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface ListDetailState {
  items: ListItem[]
  loading: boolean
  error: boolean
  setItems: Dispatch<SetStateAction<ListItem[]>>
  refetch: () => void
}

export function useListDetail(id: string | null): ListDetailState {
  const [items, setItems] = useState<ListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Counts local edits. A fetch records the count it started at and throws its answer
  // away if anything changed while it was in the air: the screen's optimistic state is
  // newer than a response the server composed before that edit reached it. Without this,
  // deleting an item just as a poll goes out puts the item back until the next tick —
  // the deletes have no success-path refetch to correct it.
  const edits = useRef(0)
  const localSetItems = useCallback<Dispatch<SetStateAction<ListItem[]>>>((v) => {
    edits.current += 1
    setItems(v)
  }, [])
  useEffect(() => {
    if (!id) {
      setItems([])
      setLoading(false)
      return
    }
    let alive = true
    const startedAt = edits.current
    setLoading(true)
    groceryApi
      .list(id)
      .then((d) => {
        if (!alive) return
        setLoading(false)
        setError(false)
        if (edits.current === startedAt) setItems(d.items)
      })
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [id, nonce])
  // Cross-device liveness: poll + refetch on focus so another family member's edits appear.
  useLiveRefresh(() => { if (id) setNonce((n) => n + 1) })
  return { items, loading, error, setItems: localSetItems, refetch: () => setNonce((n) => n + 1) }
}
