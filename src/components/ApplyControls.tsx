import type { ApplyRunSummary, DaySchedule } from '../types'
import { getTargetForDate } from '../lib/schedule'

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
  readOnly?: boolean
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
  readOnly = false,
}: ApplyControlsProps) {
  const today = new Date()
  const targetDay = getTargetForDate(schedule, today)
  const locked = readOnly || applying || saving

  return (
    <section className="section apply-section">
      <div className="section-head">
        <div>
          <h2>When it runs</h2>
          <p>
            {readOnly
              ? 'View only · admin can change settings'
              : 'Exact minute · Asia/Manila by default'}
          </p>
        </div>
        {readOnly && <span className="status-dot is-warn">Locked</span>}
      </div>

      <div className="apply-fields">
        <label className="field">
          <span>Time</span>
          <input
            type="time"
            value={applyTime}
            onChange={(e) => onApplyTimeChange(e.target.value)}
            disabled={locked}
          />
        </label>

        <label className="field">
          <span>Timezone</span>
          <input
            type="text"
            value={timezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
            placeholder="Asia/Manila"
            disabled={locked}
            spellCheck={false}
          />
        </label>
      </div>

      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={wildcard}
          onChange={(e) => onWildcardChange(e.target.checked)}
          disabled={locked}
        />
        <span>Preserve path &amp; query</span>
      </label>

      <div className="today-block">
        <span className="eyebrow">Today → {targetDay.label}</span>
        <strong className="today-url">
          {todayTarget || targetDay.targetUrl || '—'}
        </strong>
      </div>

      {lastRun && (
        <div className="last-run" role="status">
          <span>
            Last · {new Date(lastRun.ranAt).toLocaleString()}
          </span>
          <strong>
            {lastRun.success} ok · {lastRun.failed} fail
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
        <p className="status-line" role="status">
          {progressLabel}
        </p>
      )}

      {!readOnly && (
        <button
          type="button"
          className="primary-btn apply-save"
          disabled={applying || saving}
          onClick={onSave}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      )}
    </section>
  )
}
