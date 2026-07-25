import type { ApplyRunSummary, DaySchedule } from '../types'
import { dayKeyFromDate, getTargetForDate } from '../lib/schedule'

interface ApplyControlsProps {
  schedule: DaySchedule[]
  wildcard: boolean
  onWildcardChange: (value: boolean) => void
  timezone: string
  onTimezoneChange: (value: string) => void
  applyTime: string
  onApplyTimeChange: (value: string) => void
  applying: boolean
  saving: boolean
  onSave: () => void
  todayTarget: string
  lastRun: ApplyRunSummary | null
  progressLabel?: string | null
  progress?: { completed: number; total: number; currentDomain?: string } | null
}

export function ApplyControls({
  schedule,
  wildcard,
  onWildcardChange,
  timezone,
  onTimezoneChange,
  applyTime,
  onApplyTimeChange,
  applying,
  saving,
  onSave,
  todayTarget,
  lastRun,
  progressLabel,
  progress,
}: ApplyControlsProps) {
  const today = new Date()
  const targetDay = getTargetForDate(schedule, today)
  const dayKey = dayKeyFromDate(today)

  return (
    <section className="panel apply-panel">
      <header className="panel-header">
        <div>
          <h2>Daily schedule time</h2>
          <p>
            Set when 301s should run. Saving here only stores settings — it does
            not apply redirects. Redirects run only when this time is reached.
          </p>
        </div>
      </header>

      <div className="apply-grid apply-grid-2">
        <label className="field">
          <span>Timezone</span>
          <input
            type="text"
            value={timezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
            placeholder="Asia/Manila"
            disabled={applying || saving}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Daily apply time</span>
          <input
            type="time"
            value={applyTime}
            onChange={(e) => onApplyTimeChange(e.target.value)}
            disabled={applying || saving}
          />
        </label>

        <label className="checkbox-field apply-span-2">
          <input
            type="checkbox"
            checked={wildcard}
            onChange={(e) => onWildcardChange(e.target.checked)}
            disabled={applying || saving}
          />
          <span>Preserve path &amp; query (wildcard)</span>
        </label>
      </div>

      <div className="target-preview">
        <div>
          <span className="preview-label">Today ({targetDay.label})</span>
          <strong className="preview-url">
            {todayTarget || targetDay.targetUrl || '—'}
          </strong>
        </div>
        <div>
          <span className="preview-label">Auto-runs at</span>
          <strong>
            {applyTime || '00:00'} · {timezone || 'Asia/Manila'}
          </strong>
        </div>
        <div>
          <span className="preview-label">Schedule key</span>
          <strong>{dayKey}</strong>
        </div>
      </div>

      {lastRun && (
        <div className="countdown-banner" role="status">
          <span>
            Last run · {new Date(lastRun.ranAt).toLocaleString()} ·{' '}
            {lastRun.dayKey} → {lastRun.targetUrl}
          </span>
          <strong>
            {lastRun.success} ok / {lastRun.failed} fail
          </strong>
        </div>
      )}

      {progress && progress.total > 0 && (
        <div
          className="progress-wrap"
          role="progressbar"
          aria-valuenow={progress.completed}
          aria-valuemax={progress.total}
        >
          <div
            className="progress-bar"
            style={{
              width: `${(progress.completed / progress.total) * 100}%`,
            }}
          />
          <span>
            {progress.completed}/{progress.total}
            {progress.currentDomain ? ` · ${progress.currentDomain}` : ''}
          </span>
        </div>
      )}

      {progressLabel && (
        <p className="hint" role="status">
          {progressLabel}
        </p>
      )}

      <div className="apply-actions">
        <button
          type="button"
          className="secondary-btn"
          disabled={applying || saving}
          onClick={onSave}
        >
          {saving ? 'Saving…' : 'Save schedule settings'}
        </button>
      </div>

      <p className="hint">
        301s run only when Philippine time reaches Daily apply time. No manual
        apply.
      </p>
    </section>
  )
}
