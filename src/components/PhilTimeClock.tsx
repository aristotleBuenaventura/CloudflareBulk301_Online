import { useEffect, useState } from 'react'

interface PhilTimeClockProps {
  timeZone?: string
  applyTime: string
  autoWatchActive?: boolean
  scheduleStatus?: string | null
  compact?: boolean
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function getParts(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''

  let hour = get('hour')
  if (hour === '24') hour = '00'

  return {
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${pad(Number(hour))}:${get('minute')}:${get('second')}`,
    hhmm: `${pad(Number(hour))}:${get('minute')}`,
  }
}

export function PhilTimeClock({
  timeZone = 'Asia/Manila',
  applyTime,
  autoWatchActive = false,
  scheduleStatus,
  compact = false,
}: PhilTimeClockProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 250)
    return () => window.clearInterval(id)
  }, [])

  const parts = getParts(timeZone, now)
  const waiting = parts.hhmm < applyTime
  const statusText =
    scheduleStatus ||
    (waiting
      ? `Waiting until ${applyTime}`
      : 'Waiting for next schedule window')

  if (compact) {
    return (
      <div className="clock-compact" aria-live="polite">
        <div className="clock-compact-time">{parts.time}</div>
        <div className="clock-compact-meta">
          <span>
            {parts.weekday} · {parts.date}
          </span>
          <span className="clock-compact-status">
            {autoWatchActive ? 'Watching' : 'Paused'} · {statusText}
          </span>
        </div>
      </div>
    )
  }

  return (
    <section className="section clock-section" aria-live="polite">
      <div className="section-head">
        <h2>Philippine time</h2>
        {autoWatchActive && <span className="status-dot is-live">Watching</span>}
      </div>
      <div className="clock-face">
        <div className="clock-time">{parts.time}</div>
        <p className="clock-meta">
          {parts.weekday} · {parts.date} · {timeZone}
        </p>
        <p className="clock-status">{statusText}</p>
      </div>
    </section>
  )
}
