// The alarm-tone picker used to store the LABEL it displayed: picking "Gentle
// bells" wrote the string 'Gentle bells' into settings.alarm.tone. That tied
// every paired device's alarm to a piece of English copy — rename the chip and
// you repoint the alarm — and left nothing to localise, because the stored
// value was the translation. These tests pin the split the sound picker already
// had: a stable key on the wire, a label on the screen.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

type SettingsPatch = { alarm?: { tone: string } }
const updateSettings = vi.fn(async (_deviceId: string, _patch: SettingsPatch) => ({}))
let settings: Record<string, unknown> = {}

vi.mock('../lib/api', () => ({
  usePersons: () => ({ persons: [{ id: 'p-1', name: 'Hudson', avatarEmoji: '🐢', colorHex: '#25A368' }] }),
  useHousehold: () => ({ household: { id: 'h-1', modules: { waffledBites: true } } }),
  useWaffledBiteDevice: () => ({
    device: {
      id: 'dev-1',
      personId: 'p-1',
      label: "Hudson's Waffled-Bite",
      lastSeenAt: new Date().toISOString(),
      settings,
      runtimeState: {
        quiet: { running: false, remainingSec: 0 },
        timer: { running: false, remainingSec: 0 },
        wakeLight: { state: 'none' },
      },
    },
    loading: false,
    refetch: vi.fn(),
  }),
  // Wrapped rather than passed straight through: vi.mock's factory is hoisted
  // above the const, so naming it directly here is a use-before-init.
  waffledBitesApi: { updateSettings: (id: string, patch: SettingsPatch) => updateSettings(id, patch) },
}))
vi.mock('../lib/modules', () => ({ moduleEnabled: () => true }))
vi.mock('./topbar-slot', () => ({ useTopbarFull: () => {} }))
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useParams: () => ({ id: 'p-1' }), useNavigate: () => vi.fn() }
})

import { WaffledBiteDevice } from './WaffledBiteDevice'

function openAlarm(tone: string) {
  settings = { alarm: { on: true, hour: 6, min: 45, tone, volume: 80 } }
  render(<MemoryRouter><WaffledBiteDevice /></MemoryRouter>)
  fireEvent.click(screen.getByText('Morning alarm'))
}

describe('Waffled-Bite alarm tone picker', () => {
  beforeEach(() => { updateSettings.mockClear() })

  it('renders the human label for the stable key the device stores', () => {
    openAlarm('sunriseChime')

    // The key never reaches the screen…
    expect(screen.queryByText('sunriseChime')).toBeNull()
    // …its label does, and it's the selected chip.
    const chip = screen.getByRole('button', { name: 'Sunrise chime' })
    expect(chip.className).toContain('on')
    // and every other tone is offered by label too
    for (const label of ['Soft harp', 'Gentle bells', 'Ocean tide', 'Twinkle stars']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('writes the stable key, not the label, when a parent picks a tone', async () => {
    openAlarm('sunriseChime')

    fireEvent.click(screen.getByRole('button', { name: 'Gentle bells' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalled())
    expect(updateSettings.mock.calls[0][1].alarm?.tone).toBe('gentleBells')
  })

  it('still offers birdsong as the one tone awaiting a real recording', () => {
    openAlarm('sunriseChime')

    // Labelled and disabled, exactly like the sampled sounds — the device
    // synthesises the other five but this one needs a recording.
    const chip = screen.getByRole('button', { name: 'Birdsong (soon)' }) as HTMLButtonElement
    expect(chip.disabled).toBe(true)
  })

  it('selects nothing rather than guessing when the stored tone is unrecognised', () => {
    // A hand-edited or rolled-back row (migration 0095 leaves anything it
    // doesn't recognise alone). The picker must not silently show some other
    // tone as selected — the firmware's own fallback decides what actually
    // rings; the panel just shouldn't lie about what's stored.
    openAlarm('Kazoo fanfare')
    for (const label of ['Sunrise chime', 'Soft harp', 'Gentle bells', 'Ocean tide', 'Twinkle stars']) {
      expect(screen.getByRole('button', { name: label }).className).not.toContain('on')
    }
  })
})
