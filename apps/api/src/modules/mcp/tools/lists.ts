import {
  addItemFromInput,
  getList,
  getOrCreateGroceryList,
  groceryBoard,
  householdWeekStart,
  householdWeekStartFor,
  listItems,
  listLists,
  presentListItem,
} from '../../lists/lists.service'
import { defineTool, ToolInputError } from '../registry'
import { capped, DATE_SCHEMA, ID_SCHEMA, optDate, optNumber, optString, optUuid, reqString, truncNote } from '../args'
import { DATA_NOTE, READ, WRITE } from './shared'

const MAX_ITEMS = 300

function presentItemForAgent(i: ReturnType<typeof presentListItem> & { aisle?: string }) {
  return {
    id: i.id,
    name: i.name,
    quantity: i.quantity,
    checked: i.checked,
    section: i.aisle ?? i.section,
    store: i.store,
    assignee: i.assignee ? { id: i.assignee.personId, name: i.assignee.name } : null,
  }
}

defineTool({
  name: 'get_grocery_list',
  description:
    "The grocery list for one household week: hand-added items plus those built from that week's meal plan. week is any date in the week (default this week); the result's weekStart is the server's key for it. Item ids work with complete_list_item / delete_list_item." +
    DATA_NOTE,
  scope: 'lists:read',
  module: 'lists',
  annotations: { title: 'Get the grocery list', ...READ },
  inputSchema: {
    type: 'object',
    properties: { week: { ...DATE_SCHEMA, description: 'Any day in the week, YYYY-MM-DD (default this week)' } },
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const week = optDate(args, 'week')
    const weekStart = week ? await householdWeekStartFor(tenant.householdId, week) : await householdWeekStart(tenant.householdId)
    const board = await groceryBoard(tenant, weekStart)
    const c = capped(board.items.map(presentItemForAgent), MAX_ITEMS)
    const open = board.items.filter((i) => !i.checked).length
    return {
      data: { listId: board.list.id, weekStart, open, ...c },
      summary: `${open} open of ${c.total} grocery item(s) for the week of ${weekStart}${truncNote(c)}.`,
    }
  },
})

defineTool({
  name: 'list_lists',
  description:
    "The household's lists (grocery first, then custom lists) with their open-item counts. Pass listId to get that list's items. A list id works with add_list_item." +
    DATA_NOTE,
  scope: 'lists:read',
  module: 'lists',
  annotations: { title: 'List the lists', ...READ },
  inputSchema: {
    type: 'object',
    properties: { listId: { ...ID_SCHEMA, description: "Return this list's items too" } },
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const listId = optUuid(args, 'listId')
    const lists = (await listLists(tenant.householdId)).map((l) => ({ id: l.id, name: l.name, listType: l.listType, openItems: l.itemCount }))
    if (!listId) return { data: { items: lists }, summary: `${lists.length} list(s).` }
    const list = await getList(tenant.householdId, listId)
    if (!list || list.list_type === 'template') throw new ToolInputError('list not found')
    const c = capped((await listItems(tenant.householdId, listId)).map((i) => presentItemForAgent(presentListItem(i))), MAX_ITEMS)
    return {
      data: { items: lists, list: { id: list.id, name: list.name, items: c.items, total: c.total, truncated: c.truncated } },
      summary: `${lists.length} list(s); ${c.total} item(s) on ${list.name}${truncNote(c)}.`,
    }
  },
})

defineTool({
  name: 'add_list_item',
  description:
    "Add an item to a list: the grocery list unless listId (from list_lists) names another. quantity is free text (\"2 lb\", \"x4\"); priority 1 (not urgent) to 5 (urgent), default 3." +
    DATA_NOTE,
  scope: 'lists:write',
  module: 'lists',
  annotations: { title: 'Add a list item', ...WRITE },
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      listId: { ...ID_SCHEMA, description: 'Default: the grocery list' },
      quantity: { type: 'string' },
      section: { type: 'string', description: 'Aisle or section, e.g. Produce' },
      store: { type: 'string' },
      assignedTo: { ...ID_SCHEMA, description: 'A member id from list_family' },
      priority: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['name'],
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const listId = optUuid(args, 'listId') ?? (await getOrCreateGroceryList(tenant)).id
    const priority = optNumber(args, 'priority')
    const item = await addItemFromInput(tenant, listId, {
      name: reqString(args, 'name', 200),
      quantity: optString(args, 'quantity', 100),
      category: optString(args, 'section', 100),
      store: optString(args, 'store', 100),
      assignedTo: optUuid(args, 'assignedTo'),
      ...(priority !== undefined ? { priority } : {}),
    })
    return { data: { item: presentItemForAgent(presentListItem(item)) }, summary: `Added "${item.name}".`, createdId: item.id }
  },
})
