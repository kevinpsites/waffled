import { createEventFromInput, rangeEvents, isReadOnlyOrigin, type EventRow } from '../../events/events'
import { zonedToUtc } from '../../capture/tz'
import { defineTool, ToolInputError } from '../registry'
import { capped, clip, DATE_SCHEMA, ID_SCHEMA, isIsoDate, isUuid, optBool, optString, optUuid, reqString, truncNote } from '../args'
import { DATA_NOTE, READ, WRITE } from './shared'

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

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

// An all-day event is stored at the day's UTC midnight (as the calendar UI writes it);
// a timed one without an offset is household-local wall time.
function eventInstant(value: string, allDay: boolean, tz: string, key: string): string {
  if (allDay) {
    const day = value.slice(0, 10)
    if (!isIsoDate(day)) throw new ToolInputError(`${key} must start with a date as YYYY-MM-DD`)
    return `${day}T00:00:00.000Z`
  }
  if (!DATETIME_RE.test(value) || !isIsoDate(value.slice(0, 10))) {
    throw new ToolInputError(`${key} must be a date and time like 2026-11-20T15:30 (set allDay for a whole day)`)
  }
  return zonedToUtc(value, tz)
}

defineTool({
  name: 'add_event',
  description:
    "Add a calendar event. startsAt/endsAt are YYYY-MM-DDTHH:MM in the household's timezone (or include an offset); for allDay give just the date. personId is whose event it is (its color, and their default calendar if they have one connected); rrule (e.g. FREQ=WEEKLY;BYDAY=TU) makes it repeat." +
    DATA_NOTE,
  scope: 'calendar:write',
  annotations: { title: 'Add an event', ...WRITE },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      startsAt: { type: 'string' },
      endsAt: { type: 'string' },
      allDay: { type: 'boolean' },
      location: { type: 'string' },
      description: { type: 'string' },
      personId: { ...ID_SCHEMA, description: 'Whose event (from list_family)' },
      participantIds: { type: 'array', items: ID_SCHEMA, description: 'Everyone involved' },
      rrule: { type: 'string', description: 'RFC 5545 RRULE for a repeating event' },
    },
    required: ['title', 'startsAt'],
    additionalProperties: false,
  },
  run: async (tenant, args, ctx) => {
    const allDay = optBool(args, 'allDay') ?? false
    const startsAt = eventInstant(reqString(args, 'startsAt', 40), allDay, ctx.timezone, 'startsAt')
    const endsRaw = optString(args, 'endsAt', 40)
    const participantIds = args.participantIds
    if (participantIds != null && (!Array.isArray(participantIds) || !participantIds.every(isUuid))) {
      throw new ToolInputError('participantIds must be a list of member ids')
    }
    const event = await createEventFromInput(tenant, {
      title: reqString(args, 'title', 200),
      startsAt,
      endsAt: endsRaw ? eventInstant(endsRaw, allDay, ctx.timezone, 'endsAt') : null,
      allDay,
      location: optString(args, 'location', 300) ?? null,
      description: optString(args, 'description', 2000) ?? null,
      personId: optUuid(args, 'personId') ?? null,
      ...(participantIds ? { participantIds: participantIds as string[] } : {}),
      rrule: optString(args, 'rrule', 300) ?? null,
    })
    return { data: { event: presentEventForAgent(event) }, summary: `Added "${event.title}".`, createdId: event.id }
  },
})
