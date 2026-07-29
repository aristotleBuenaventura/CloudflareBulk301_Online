import { useEffect, useState } from 'react'
import { formatApplyTime12, pad2 } from '../lib/applyTime'

interface PhilTimeClockProps {
  timeZone?: string
  applyTime: string
  autoWatchActive?: boolean
  scheduleStatus?: string | null
  compact?: boolean
}

function getParts(timeZone: string, date: Date) {
  const parts24 = new Intl.DateTimeFormat('en-GB', {
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
    parts24.find((p) => p.type === type)?.value ?? ''

  let hour = get('hour')
  if (hour === '24') hour = '00'
  const hourNum = Number(hour)
  const minute = get('minute')
  const second = get('second')
  const period = hourNum >= 12 ? 'PM' : 'AM'
  const hour12 = hourNum % 12 === 0 ? 12 : hourNum % 12

  return {
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour12}:${pad2(Number(minute))}:${pad2(Number(second))} ${period}`,
    hhmm: `${pad2(hourNum)}:${minute}`,
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
  const applyLabel = formatApplyTime12(applyTime)
  const statusText =
    scheduleStatus ||
    (waiting
      ? `Waiting until ${applyLabel}`
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
