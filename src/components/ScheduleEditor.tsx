import type { DaySchedule } from '../types'
import { dayKeyFromDate } from '../lib/schedule'

interface ScheduleEditorProps {
  schedule: DaySchedule[]
  highlightDate: Date
  dirty?: boolean
  saving?: boolean
  readOnly?: boolean
  onChange: (key: DaySchedule['key'], targetUrl: string) => void
  onSave?: () => void
}

export function ScheduleEditor({
  schedule,
  highlightDate,
  dirty = false,
  saving = false,
  readOnly = false,
  onChange,
  onSave,
}: ScheduleEditorProps) {
  const activeKey = dayKeyFromDate(highlightDate)
  const locked = readOnly || saving

  return (
    <section className="section schedule-section">
      <div className="section-head">
        <div>
          <h2>Weekly targets</h2>
          <p>
            {readOnly
              ? 'View only · admin can edit targets'
              : 'Enter to save · 301s run on schedule only'}
          </p>
        </div>
        {dirty && !readOnly && (
          <span className="status-dot is-warn">Unsaved</span>
        )}
        {saving && <span className="status-dot">Saving…</span>}
        {readOnly && <span className="status-dot is-warn">Locked</span>}
      </div>

      <div className="schedule-list" role="list">
        {schedule.map((day) => {
          const isActive = day.key === activeKey

          return (
            <div
              key={day.key}
              role="listitem"
              className={['schedule-row', isActive ? 'is-active' : '']
                .filter(Boolean)
                .join(' ')}
            >
              <div className="day-label">
                <span className="day-short">{day.short}</span>
                {isActive && <span className="day-badge">Today</span>}
              </div>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                value={day.targetUrl}
                disabled={locked}
                readOnly={readOnly}
                onChange={(e) => onChange(day.key, e.target.value)}
                onKeyDown={(e) => {
                  if (readOnly) return
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
