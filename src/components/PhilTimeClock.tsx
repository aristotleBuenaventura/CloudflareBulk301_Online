import { useEffect, useState } from 'react'

interface PhilTimeClockProps {
  timeZone?: string
  applyTime: string
  autoWatchActive?: boolean
  scheduleStatus?: string | null
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function getParts(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
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
}: PhilTimeClockProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 250)
    return () => window.clearInterval(id)
  }, [])

  const parts = getParts(timeZone, now)
  const waiting = parts.hhmm < applyTime

  return (
    <section className="panel phil-clock-panel" aria-live="polite">
      <header className="panel-header">
        <div>
          <h2>Philippine time</h2>
          <p>Live clock used for the daily auto 301 schedule.</p>
        </div>
        {autoWatchActive && (
          <span className="count-pill watch-pill">Auto-watch on</span>
        )}
      </header>

      <div className="phil-clock-face">
        <div className="phil-clock-time">{parts.time}</div>
        <div className="phil-clock-meta">
          {parts.weekday} · {parts.date} · {timeZone}
        </div>
      </div>

      <div className="target-preview">
        <div>
          <span className="preview-label">Scheduled apply</span>
          <strong>
            {applyTime || '00:00'} daily ({timeZone})
          </strong>
        </div>
        <div>
          <span className="preview-label">Status</span>
          <strong>
            {scheduleStatus ||
              (waiting
                ? `Waiting until ${applyTime}…`
                : `Waiting for schedule window / next day`)}
          </strong>
        </div>
      </div>
    </section>
  )
}
