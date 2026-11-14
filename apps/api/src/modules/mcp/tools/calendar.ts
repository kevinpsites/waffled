import { rangeEvents, isReadOnlyOrigin, type EventRow } from '../../events/events'
import { defineTool, ToolInputError } from '../registry'
import { capped, clip, DATE_SCHEMA, isIsoDate, truncNote } from '../args'
import { DATA_NOTE, READ } from './shared'

const MAX_SPAN_DAYS = 62
const MAX_EVENTS = 200

export function presentEventForAgent(e: EventRow) {
  return {
    id: e.id,
    seriesId: e.series_id ?? e.id,
    title: e.title,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    allDay: e.all_day,
    location: e.location,
    description: clip(e.description),
    person: e.person_id ? { id: e.person_id, name: e.person_name ?? null } : null,
    participants: (e.participants ?? []).map((p) => ({ id: p.id, name: p.name })),
    recurring: e.occurrence_start != null,
    // Feed-imported events can't be changed from Waffled.
    readOnly: isReadOnlyOrigin(e.origin),
  }
}

defineTool({
  name: 'list_events',
  description:
    'Calendar events between two dates (inclusive, household-local, at most 62 days). Each item has an id usable with reschedule_event / delete_event; a recurring event lists each occurrence with its own id.' +
    DATA_NOTE,
  scope: 'calendar:read',
  annotations: { title: 'List calendar events', ...READ },
  inputSchema: {
    type: 'object',
    properties: { from: { ...DATE_SCHEMA, description: 'First day, YYYY-MM-DD' }, to: { ...DATE_SCHEMA, description: 'Last day, YYYY-MM-DD' } },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  run: async (tenant, args) => {
    const { from, to } = args
    if (!isIsoDate(from) || !isIsoDate(to)) throw new ToolInputError('from and to must be dates as YYYY-MM-DD')
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000
    if (span < 0) throw new ToolInputError('to must not be before from')
    if (span >= MAX_SPAN_DAYS) throw new ToolInputError(`a range covers at most ${MAX_SPAN_DAYS} days`)
    const events = await rangeEvents(tenant.householdId, from, to, tenant.personId)
    const c = capped(events.map(presentEventForAgent), MAX_EVENTS)
    return { data: { from, to, ...c }, summary: `${c.total} event(s) from ${from} to ${to}${truncNote(c)}.` }
  },
})
