import { render, screen } from '@testing-library/react'
import { MonthView } from './MonthView'
import { WeekView } from './WeekView'
import { DayView } from './DayView'
import { AgendaView } from './AgendaView'
import { MonthDayPanel } from './MonthDayPanel'
import { ymd, startOfWeek } from './cal-utils'
import { solidChipInk } from '../../lib/event-color'
import type { AgendaEvent } from '../../lib/api'

// Event chips carry their color as the `--ev` custom property and take the
// `.ev-tint` class, so the stylesheet decides how to paint them — solid fills
// (the household default) or the softer wash — instead of a hardcoded
// `${color}22` background + raw color text baked into every view.
//
// Separately, the *color itself* is resolved through useEventColor: an event
// that covers the whole household paints in the household's family color.

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const COLOR = '#2F7FED'
const FAMILY = '#ABC123'

const at = (h: number) => {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d.toISOString()
}

const makeEvents = () =>
  [
    { id: 'timed', seriesId: null, occurrenceStart: null, title: 'Swim practice', allDay: false, startsAt: at(15), endsAt: at(16), personColor: COLOR, participants: [] },
    { id: 'allday', seriesId: null, occurrenceStart: null, title: 'Spirit week', allDay: true, startsAt: at(0), endsAt: null, personColor: COLOR, participants: [] },
  ] as unknown as AgendaEvent[]

const MEMBERS = [
  { id: 'p1', name: 'Kevin', colorHex: COLOR, avatarEmoji: null },
  { id: 'p2', name: 'Kelly', colorHex: '#EC6049', avatarEmoji: null },
]

// A household whose two members are both on the timed event = a family event.
function mockHousehold(familyColorHex?: string) {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/persons')) return { ok: true, json: async () => ({ persons: MEMBERS }) }
    if (String(url).includes('/api/household'))
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h1', name: 'Sites', timezone: 'UTC', weekStart: 'sunday', location: null, ownerPersonId: null, settings: familyColorHex ? { display: { familyColorHex } } : {} },
        }),
      }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function familyEvents(): AgendaEvent[] {
  const events = makeEvents()
  events[0] = { ...events[0], participants: MEMBERS } as unknown as AgendaEvent
  return events
}

// jsdom normalizes inline colors to rgb() — compare against that.
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

beforeEach(() => {
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

// The chip carries the person color only as `--ev` for CSS to paint — no literal
// alpha-wash background, no raw text color — plus the ink that stays readable on
// that color once the solid style fills the chip with it.
function expectTinted(el: Element | null) {
  expect(el).toBeTruthy()
  const chip = el as HTMLElement
  expect(chip.classList.contains('ev-tint')).toBe(true)
  expect(chip.style.getPropertyValue('--ev')).toBe(COLOR)
  expect(chip.style.getPropertyValue('--ev-on')).toBe(solidChipInk(COLOR).light)
  expect(chip.style.getPropertyValue('--ev-on-dark')).toBe(solidChipInk(COLOR).dark)
  expect(chip.style.backgroundColor).toBe('')
  expect(chip.style.color).toBe('')
}

function renderMonth(events: AgendaEvent[]) {
  const now = new Date()
  return render(
    <MonthView
      firstDay={0}
      year={now.getFullYear()}
      month={now.getMonth()}
      events={events}
      tz={TZ}
      selectedDay={ymd(now)}
      onSelectDay={() => {}}
      onOpenEvent={() => {}}
      onCreateOnDay={() => {}}
      onMore={() => {}}
    />
  )
}

describe('calendar event chips paint through the CSS event style', () => {
  it('MonthView .ev chips tint via --ev, not a hardcoded wash', async () => {
    renderMonth(makeEvents())
    const chips = await screen.findAllByText('Swim practice')
    expectTinted(chips.map((c) => c.closest('.ev')).find(Boolean) ?? null)
  })

  it('WeekView timed + all-day chips tint via --ev', async () => {
    render(<WeekView weekStart={startOfWeek(new Date(), 0)} events={makeEvents()} tz={TZ} onOpenEvent={() => {}} onCreate={() => {}} />)
    expectTinted((await screen.findByText('Swim practice')).closest('.wk-ev'))
    expectTinted((await screen.findByText('Spirit week')).closest('.wk-allday-ev'))
  })

  it('DayView timed + all-day chips tint via --ev', async () => {
    render(<DayView day={new Date()} events={makeEvents()} tz={TZ} onOpenEvent={() => {}} onCreate={() => {}} />)
    expectTinted((await screen.findByText('Swim practice')).closest('.dv-ev'))
    expectTinted((await screen.findByText('Spirit week')).closest('.dv-allday-ev'))
  })
})

describe('whole-family events render in the household family color', () => {
  it('MonthView paints an everyone-event with settings.display.familyColorHex', async () => {
    mockHousehold(FAMILY)
    renderMonth(familyEvents())

    const chip = (await screen.findAllByText('Swim practice')).map((c) => c.closest('.ev')).find(Boolean) as HTMLElement
    await vi.waitFor(() => expect(chip.style.getPropertyValue('--ev')).toBe(FAMILY))
    // …while the partial event (only the implicit owner) keeps the person color.
    const partial = (await screen.findAllByText('Spirit week')).map((c) => c.closest('.ev')).find(Boolean) as HTMLElement
    expect(partial.style.getPropertyValue('--ev')).toBe(COLOR)
  })

  it('the Agenda list bar uses the family color too', async () => {
    mockHousehold(FAMILY)
    render(<AgendaView events={familyEvents()} tz={TZ} onOpenEvent={() => {}} onPickDate={() => {}} onCreate={() => {}} />)

    const row = (await screen.findByText('Swim practice')).closest('.ag-row') as HTMLElement
    const bar = row.querySelector('.ag-bar') as HTMLElement
    await vi.waitFor(() => expect(bar.style.background).toBe(rgb(FAMILY)))
  })

  it("the month view's day panel uses the family color too", async () => {
    mockHousehold(FAMILY)
    const now = new Date()
    render(<MonthDayPanel day={ymd(now)} events={familyEvents()} tz={TZ} onOpenEvent={() => {}} onCreate={() => {}} />)

    const row = (await screen.findByText('Swim practice')).closest('.ag-row') as HTMLElement
    const bar = row.querySelector('.ag-bar') as HTMLElement
    await vi.waitFor(() => expect(bar.style.background).toBe(rgb(FAMILY)))
  })
})
