import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import {
  usePersons,
  useHousehold,
  waffledBitesApi,
  useWaffledBiteDevice,
  type WaffledBiteSettings,
  type WaffledBiteSchedule,
} from '../lib/api'
import { moduleEnabled } from '../lib/modules'
import { WaffledBitePairModal } from './components/WaffledBitePairModal'

const NIGHT_COLORS: Array<[string, string]> = [
  ['amber', '#F0A94B'], ['peach', '#F28E6B'], ['blush', '#EF7FA6'],
  ['lilac', '#A98BE8'], ['ocean', '#5AA7E0'], ['mint', '#5BC98B'],
]
const SOUNDS: Array<[string, string]> = [
  ['white', 'White noise'], ['ocean', 'Ocean waves'], ['rain', 'Gentle rain'],
  ['fan', 'Box fan'], ['heartbeat', 'Heartbeat'], ['lullaby', 'Lullaby'], ['forest', 'Forest'],
]
const ALARM_TONES = ['Sunrise chime', 'Birdsong', 'Soft harp', 'Gentle bells', 'Ocean tide', 'Twinkle stars']
const SLEEP_TIMERS = [0, 15, 30, 60, 120]
const DOW: Array<[number, string]> = [[0, 'S'], [1, 'M'], [2, 'T'], [3, 'W'], [4, 'T'], [5, 'F'], [6, 'S']]
const QUIET_PRESETS = [10, 15, 20, 30]

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}` }
function minToHHMM(min: number): string { const h = Math.floor(min / 60) % 24; return `${pad(h)}:${pad(min % 60)}` }
function hhmmToMin(s: string): number { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0) }
function fmtMMSS(sec: number): string { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${pad(s % 60)}` }
function schedName(days: number[]): string {
  const s = [...days].sort().join(',')
  if (s === '1,2,3,4,5') return 'School days'
  if (s === '0,6') return 'Weekend'
  if (s === '0,1,2,3,4,5,6') return 'Every day'
  return days.length ? 'Custom' : 'No days set'
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card pp-card">
      <div className="card-h" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )
}

function Stepper({ value, onChange, step = 1, min, max, format }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; format?: (v: number) => string
}) {
  const clamp = (v: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" className="btn btn-ghost" style={{ padding: '6px 12px' }} onClick={() => onChange(clamp(value - step))}>–</button>
      <span style={{ fontWeight: 700, minWidth: 48, textAlign: 'center' }}>{format ? format(value) : value}</span>
      <button type="button" className="btn btn-ghost" style={{ padding: '6px 12px' }} onClick={() => onChange(clamp(value + step))}>+</button>
    </div>
  )
}

function ChipPicker<T extends string>({ options, value, onChange }: { options: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="rw-cur-pick">
      {options.map(([id, label]) => (
        <button key={id} type="button" className={`rw-cur-chip ${value === id ? 'on' : ''}`} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 700 }} onClick={(e) => { e.preventDefault(); onChange(!on) }}>
      <span className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} />
      <span>{label}</span>
    </label>
  )
}

// Live quiet-time countdown: ticks locally from the last-fetched remainingSec so
// the card doesn't need to re-poll every second; `resync` re-reads the server value
// after a mutation (start/pause/resume/+5/end).
function useLocalCountdown(remainingSec: number, running: boolean) {
  const [local, setLocal] = useState(remainingSec)
  useEffect(() => setLocal(remainingSec), [remainingSec])
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setLocal((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [running])
  return local
}

export function WaffledBiteDevice() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { persons } = usePersons()
  const { household } = useHousehold()
  const person = persons.find((p) => p.id === id)
  const { device, loading, refetch } = useWaffledBiteDevice(id ?? null)
  const [pairing, setPairing] = useState(false)
  const settingsRef = useRef<WaffledBiteSettings>({})
  if (device) settingsRef.current = device.settings

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(`/person/${id}`)}>‹ {person?.name ?? 'Back'}</button>
      </div>
    ),
    [navigate, id, person?.name]
  )

  const enabled = moduleEnabled(household, 'waffledBites')
  const quietRemaining = useLocalCountdown(device?.runtimeState.quiet.remainingSec ?? 0, device?.runtimeState.quiet.running ?? false)

  async function patchSettings(patch: WaffledBiteSettings) {
    if (!device) return
    await waffledBitesApi.updateSettings(device.id, patch)
    refetch()
  }

  if (!enabled) return <div className="muted" style={{ padding: 30 }}>The Waffled-Bites module is off — turn it on in Settings → Modules.</div>
  if (loading || !person) return <div className="muted" style={{ padding: 30 }}>Loading…</div>

  if (!device) {
    return (
      <div style={{ padding: 30, textAlign: 'center' }}>
        <div className="wf-serif" style={{ fontSize: 22, marginBottom: 8 }}>No Waffled-Bite paired yet</div>
        <div className="muted tiny" style={{ fontWeight: 600, marginBottom: 18 }}>Pair {person.name}'s device to control it from here.</div>
        <button type="button" className="btn btn-primary" onClick={() => setPairing(true)}>Pair a Waffled-Bite</button>
        {pairing && (
          <WaffledBitePairModal
            personId={person.id}
            personName={person.name}
            onClose={() => setPairing(false)}
            onPaired={() => { setPairing(false); refetch() }}
          />
        )}
      </div>
    )
  }

  const s = device.settings
  const night = s.night ?? { on: false, color: 'amber', brightness: 40 }
  const sound = s.sound ?? { on: false, sound: 'ocean', volume: 45, timerMin: 0 }
  const alarm = s.alarm ?? { on: false, hour: 6, min: 45, tone: 'Sunrise chime' }
  const display = s.display ?? { brightness: 85, nightDim: true }
  const schedules = s.schedules ?? []
  const quiet = device.runtimeState.quiet

  function updateSchedule(i: number, patch: Partial<WaffledBiteSchedule>) {
    const next = schedules.map((sch, idx) => (idx === i ? { ...sch, ...patch } : sch))
    patchSettings({ schedules: next })
  }
  function toggleScheduleDay(i: number, day: number) {
    const sch = schedules[i]
    const days = sch.days.includes(day) ? sch.days.filter((d) => d !== day) : [...sch.days, day].sort()
    updateSchedule(i, { days })
  }

  return (
    <div className="person-profile">
      <div className="pp-left">
        <div className="pp-hero">
          <span className="pp-av" style={{ background: person.colorHex ? `${person.colorHex}22` : 'var(--panel)' }}>{person.avatarEmoji ?? '🙂'}</span>
          <div>
            <div className="wf-serif pp-name">{person.name}'s Waffled-Bite</div>
            <div className="pp-sub">{device.label}</div>
          </div>
        </div>

        <Card title="Quiet time">
          {quiet.active ? (
            <>
              <div style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums', margin: '4px 0 6px' }}>{fmtMMSS(quietRemaining)}</div>
              <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>{quiet.running ? 'Counting down on the device' : 'Paused'}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost" onClick={() => waffledBitesApi[quiet.running ? 'quietPause' : 'quietResume'](device.id).then(refetch)}>
                  {quiet.running ? '⏸ Pause' : '▶ Resume'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => waffledBitesApi.quietAddTime(device.id, 300).then(refetch)}>+5 min</button>
                <button type="button" className="btn btn-primary" onClick={() => waffledBitesApi.quietEnd(device.id).then(refetch)}>End now</button>
              </div>
            </>
          ) : (
            <>
              <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 10 }}>Start a calm stay-in-room countdown on the device.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {QUIET_PRESETS.map((m) => (
                  <button key={m} type="button" className="btn btn-ghost" onClick={() => waffledBitesApi.quietStart(device.id, m * 60).then(refetch)}>{m}m</button>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card title="Nightlight">
          <Toggle on={night.on} onChange={(v) => patchSettings({ night: { ...night, on: v } })} label={night.on ? 'On' : 'Off'} />
          {night.on && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 12 }}>
                {NIGHT_COLORS.map(([id, hex]) => (
                  <button key={id} type="button" aria-label={id} onClick={() => patchSettings({ night: { ...night, color: id } })}
                    style={{ width: 30, height: 30, borderRadius: 999, background: hex, border: night.color === id ? '3px solid var(--ink)' : '2px solid #fff', boxShadow: '0 0 0 1px var(--hair)', cursor: 'pointer' }} />
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="tiny muted" style={{ fontWeight: 700 }}>Brightness</span>
                <Stepper value={night.brightness} step={10} min={10} max={100} format={(v) => `${v}%`} onChange={(v) => patchSettings({ night: { ...night, brightness: v } })} />
              </div>
            </div>
          )}
        </Card>

        <Card title="Sound machine">
          <Toggle on={sound.on} onChange={(v) => patchSettings({ sound: { ...sound, on: v } })} label={sound.on ? 'Playing' : 'Off'} />
          {sound.on && (
            <div style={{ marginTop: 12 }}>
              <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 6 }}>Sound</div>
              <ChipPicker options={SOUNDS} value={sound.sound} onChange={(id) => patchSettings({ sound: { ...sound, sound: id } })} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
                <span className="tiny muted" style={{ fontWeight: 700 }}>Volume</span>
                <Stepper value={sound.volume} step={5} min={0} max={100} format={(v) => `${v}%`} onChange={(v) => patchSettings({ sound: { ...sound, volume: v } })} />
              </div>
              <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 6 }}>Sleep timer</div>
              <div style={{ display: 'flex', gap: 7 }}>
                {SLEEP_TIMERS.map((m) => (
                  <button key={m} type="button" className={`rw-cur-chip ${sound.timerMin === m ? 'on' : ''}`} onClick={() => patchSettings({ sound: { ...sound, timerMin: m } })}>
                    {m === 0 ? 'Off' : m >= 60 ? `${m / 60}h` : `${m}m`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="pp-right">
        <Card title="Wake-light schedule">
          <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 10 }}>Tap the days each rule covers.</div>
          {schedules.map((sch, i) => (
            <div key={i} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: i < schedules.length - 1 ? '1px solid var(--hair)' : 'none' }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{schedName(sch.days)}</div>
              <div className="chore-days" style={{ marginBottom: 10 }}>
                {DOW.map(([d, label]) => (
                  <button key={d} type="button" className={`chore-day ${sch.days.includes(d) ? 'on' : ''}`} onClick={() => toggleScheduleDay(i, d)}>{label}</button>
                ))}
              </div>
              <div className="field-row">
                <label className="field">
                  <span>🟢 Okay to get up</span>
                  <input type="time" value={minToHHMM(sch.wakeMin)} onChange={(e) => updateSchedule(i, { wakeMin: hhmmToMin(e.target.value) })} />
                </label>
                <label className="field">
                  <span>🟡 Yellow warning (min before)</span>
                  <input type="number" min={0} max={30} value={sch.leadMin} onChange={(e) => updateSchedule(i, { leadMin: Number(e.target.value) || 0 })} />
                </label>
              </div>
              {schedules.length > 1 && (
                <button type="button" className="btn btn-ghost" style={{ marginTop: 6 }} onClick={() => patchSettings({ schedules: schedules.filter((_, idx) => idx !== i) })}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => patchSettings({ schedules: [...schedules, { days: [], wakeMin: 7 * 60, leadMin: 10 }] })}>＋ Add another schedule</button>
        </Card>

        <Card title="Morning alarm">
          <Toggle on={alarm.on} onChange={(v) => patchSettings({ alarm: { ...alarm, on: v } })} label={alarm.on ? 'On' : 'Off'} />
          {alarm.on && (
            <div style={{ marginTop: 12 }}>
              <label className="field" style={{ marginBottom: 10 }}>
                <span>Time</span>
                <input type="time" value={minToHHMM(alarm.hour * 60 + alarm.min)} onChange={(e) => {
                  const m = hhmmToMin(e.target.value)
                  patchSettings({ alarm: { ...alarm, hour: Math.floor(m / 60), min: m % 60 } })
                }} />
              </label>
              <div className="tiny muted" style={{ fontWeight: 700, marginBottom: 6 }}>Alarm sound</div>
              <ChipPicker options={ALARM_TONES.map((t) => [t, t] as [string, string])} value={alarm.tone} onChange={(t) => patchSettings({ alarm: { ...alarm, tone: t } })} />
            </div>
          )}
        </Card>

        <Card title="Screen & display">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span className="tiny muted" style={{ fontWeight: 700 }}>Brightness</span>
            <Stepper value={display.brightness} step={10} min={10} max={100} format={(v) => `${v}%`} onChange={(v) => patchSettings({ display: { ...display, brightness: v } })} />
          </div>
          <Toggle on={display.nightDim} onChange={(v) => patchSettings({ display: { ...display, nightDim: v } })} label="Screen goes dark at night" />
        </Card>

        <button
          type="button"
          className="btn btn-ghost"
          style={{ color: 'var(--danger, #b3372c)' }}
          onClick={() => { if (confirm(`Unpair ${person.name}'s Waffled-Bite?`)) waffledBitesApi.unpair(device.id).then(() => navigate(`/person/${id}`)) }}
        >
          Unpair this Waffled-Bite
        </button>
      </div>
    </div>
  )
}
