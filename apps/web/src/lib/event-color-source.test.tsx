// useEventColor needs the member list and the household's family color. Seven
// components use it (month/week/day/agenda/day-panel/today card/event detail), and
// each one used to bring its own uncached usePersons() + useHousehold() — so a
// calendar screen opened with a fetch pair per view, and a single
// HOUSEHOLD_CHANGED emit (every settings save, on an always-on kiosk) cost one
// household refetch *per mounted consumer*. The data is now shared.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useEventColor } from './event-color'
import { emitHouseholdChanged } from './api/persons'

const MEMBERS = [
  { id: 'p1', name: 'Kevin', colorHex: '#2F7FED', avatarEmoji: null },
  { id: 'p2', name: 'Kelly', colorHex: '#EC6049', avatarEmoji: null },
]

let calls: string[] = []

function mockApi(familyColorHex: string) {
  calls = []
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: MEMBERS }) }
    if (u.includes('/api/household'))
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h1', name: 'Sites', timezone: 'UTC', weekStart: 'sunday', location: null, ownerPersonId: null, settings: { display: { familyColorHex } } },
        }),
      }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const countOf = (fragment: string) => calls.filter((u) => u.includes(fragment)).length

// A family event (both members), so the color comes from the household.
const FAMILY_EVENT = { personId: null, personColor: '#111111', participants: MEMBERS } as never

function Probe({ id }: { id: number }) {
  const colorOf = useEventColor()
  return <span data-testid={`probe-${id}`}>{colorOf(FAMILY_EVENT)}</span>
}

const SEVEN = [0, 1, 2, 3, 4, 5, 6]

describe('the event-color data is fetched once for the whole screen', () => {
  beforeEach(() => {
    mockApi('#ABCDEF')
  })

  it('serves every consumer from one fetch pair', async () => {
    render(<>{SEVEN.map((i) => <Probe key={i} id={i} />)}</>)

    await waitFor(() => expect(screen.getByTestId('probe-6')).toHaveTextContent('#ABCDEF'))
    for (const i of SEVEN) expect(screen.getByTestId(`probe-${i}`)).toHaveTextContent('#ABCDEF')
    expect(countOf('/api/persons')).toBe(1)
    expect(countOf('/api/household')).toBe(1)
  })

  it('answers a household-changed emit once, not once per consumer', async () => {
    render(<>{SEVEN.map((i) => <Probe key={i} id={i} />)}</>)
    await waitFor(() => expect(countOf('/api/household')).toBe(1))

    mockApi('#FEDCBA')
    emitHouseholdChanged()

    await waitFor(() => expect(screen.getByTestId('probe-0')).toHaveTextContent('#FEDCBA'))
    expect(countOf('/api/household')).toBe(1)
    expect(countOf('/api/persons')).toBe(1)
  })

  it('re-reads on a fresh screen rather than serving the last one', async () => {
    const first = render(<Probe id={0} />)
    await waitFor(() => expect(screen.getByTestId('probe-0')).toHaveTextContent('#ABCDEF'))
    first.unmount()

    mockApi('#012345')
    render(<Probe id={0} />)
    await waitFor(() => expect(screen.getByTestId('probe-0')).toHaveTextContent('#012345'))
  })
})
