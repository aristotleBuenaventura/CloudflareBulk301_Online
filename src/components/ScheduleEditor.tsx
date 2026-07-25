import type { DaySchedule } from '../types'
import { dayKeyFromDate } from '../lib/schedule'

interface ScheduleEditorProps {
  schedule: DaySchedule[]
  highlightDate: Date
  dirty?: boolean
  saving?: boolean
  onChange: (key: DaySchedule['key'], targetUrl: string) => void
  onSave?: () => void
}

export function ScheduleEditor({
  schedule,
  highlightDate,
  dirty = false,
  saving = false,
  onChange,
  onSave,
}: ScheduleEditorProps) {
  const activeKey = dayKeyFromDate(highlightDate)

  return (
    <section className="panel schedule-panel">
      <header className="panel-header">
        <div>
          <h2>Weekly target schedule</h2>
          <p>Edit a target URL, then press Enter to save. 301s only run on schedule.</p>
        </div>
        {dirty && <span className="count-pill">Unsaved — press Enter</span>}
        {saving && <span className="count-pill">Saving…</span>}
      </header>

      <div className="schedule-list" role="list">
        {schedule.map((day) => {
          const isActive = day.key === activeKey
          const isWeekend = day.key === 'saturday' || day.key === 'sunday'

          return (
            <div
              key={day.key}
              role="listitem"
              className={[
                'schedule-row',
                isActive ? 'is-active' : '',
                isWeekend ? 'is-weekend' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="day-label">
                <span className="day-short">{day.short}</span>
                <span className="day-full">{day.label}</span>
                {isActive && <span className="day-badge">Today</span>}
              </div>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                value={day.targetUrl}
                disabled={saving}
                onChange={(e) => onChange(day.key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (onSave) onSave()
                  }
                }}
                placeholder="https://target.example"
                spellCheck={false}
                aria-label={`Target domain for ${day.label}`}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}
