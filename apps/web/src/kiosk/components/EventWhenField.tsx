import { useEffect, useRef, useState } from 'react'
import { useHousehold } from '../../lib/api'
import { DayPicker } from './DayPicker'
import { dayLabel, endOf, keepSpan, minutesUntil, timeLabel, timeSlots } from './event-when'

export interface WhenValue {
  day: string
  time: string
  durationMin: number
  allDay: boolean
  // The last day an all-day event covers (inclusive); saved as the exclusive end.
  lastDay: string
}

type Pill = 'startDate' | 'startTime' | 'endDate' | 'endTime'

// All day, Starts and Ends in one field, like the iPhone editor's When card: dates and times are
// pills that open their picker under the row. A timed event's length stays the source of truth,
// so moving the start keeps it; rules and labels live in event-when.ts.
export function EventWhenField({ value, onChange }: { value: WhenValue; onChange: (next: WhenValue) => void }) {
  const { household } = useHousehold()
  const firstDay = household?.weekStart === 'monday' ? 1 : 0
  const [open, setOpen] = useState<Pill | null>(null)
  const end = endOf(value.day, value.time, value.durationMin)

  const pick = (next: WhenValue) => {
    setOpen(null)
    onChange(next)
  }
  const setEnd = (day: string, time: string) => pick({ ...value, durationMin: minutesUntil(value.day, value.time, day, time) })

  const pill = (id: Pill, name: string, text: string) => (
    <button
      type="button"
      className={`ew-pill ${open === id ? 'on' : ''}`}
      aria-label={name}
      aria-expanded={open === id}
      onClick={() => setOpen((o) => (o === id ? null : id))}
    >
      {text}
    </button>
  )

  const picker = (ids: Pill[]) => {
    if (!open || !ids.includes(open)) return null
    switch (open) {
      case 'startDate':
        return (
          <DayPicker
            className="ew-picker"
            withYear
            firstDay={firstDay}
            selected={value.day}
            onPick={(day) => pick({ ...value, day, lastDay: keepSpan(value.day, day, value.lastDay) })}
          />
        )
      case 'endDate':
        return value.allDay ? (
          <DayPicker
            className="ew-picker"
            withYear
            firstDay={firstDay}
            selected={value.lastDay}
            onPick={(day) => pick({ ...value, lastDay: day < value.day ? value.day : day })}
          />
        ) : (
          <DayPicker className="ew-picker" withYear firstDay={firstDay} selected={end.day} onPick={(day) => setEnd(day, end.time)} />
        )
      case 'startTime':
        return <TimeList selected={value.time} onPick={(time) => pick({ ...value, time })} />
      case 'endTime':
        return <TimeList selected={end.time} onPick={(time) => setEnd(end.day, time)} />
    }
  }

  return (
    <div className="field ew">
      <button
        type="button"
        role="switch"
        aria-checked={value.allDay}
        aria-label="All day"
        className="ew-allday"
        onClick={() => pick({ ...value, allDay: !value.allDay })}
      >
        <span>All day</span>
        <span className={`toggle ${value.allDay ? 'on' : ''}`} aria-hidden />
      </button>
      <div className="ew-row">
        <span className="ew-label">Starts</span>
        <div className="ew-pills">
          {pill('startDate', 'Start date', dayLabel(value.day))}
          {!value.allDay && pill('startTime', 'Start time', timeLabel(value.time))}
        </div>
        {picker(['startDate', 'startTime'])}
      </div>
      <div className="ew-row">
        <span className="ew-label">Ends</span>
        <div className="ew-pills">
          {pill('endDate', 'End date', dayLabel(value.allDay ? value.lastDay : end.day))}
          {!value.allDay && pill('endTime', 'End time', timeLabel(end.time))}
        </div>
        {picker(['endDate', 'endTime'])}
      </div>
    </div>
  )
}

// Every 15 minutes, opened scrolled to the current time.
function TimeList({ selected, onPick }: { selected: string; onPick: (time: string) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = list.current
    const on = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (el && on) el.scrollTop = on.offsetTop - el.clientHeight / 2
  }, [])
  return (
    <div className="ew-times" role="listbox" aria-label="Times" ref={list}>
      {timeSlots().map((t) => (
        <button
          type="button"
          key={t}
          role="option"
          aria-selected={t === selected}
          className={`ew-time ${t === selected ? 'on' : ''}`}
          onClick={() => onPick(t)}
        >
          {timeLabel(t)}
        </button>
      ))}
    </div>
  )
}
