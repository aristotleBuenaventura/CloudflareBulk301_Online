import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApplyControls } from './components/ApplyControls'
import { DomainUploader } from './components/DomainUploader'
import { LoginScreen } from './components/LoginScreen'
import { PhilTimeClock } from './components/PhilTimeClock'
import { ResultsPanel } from './components/ResultsPanel'
import { ScheduleEditor } from './components/ScheduleEditor'
import {
  applyStream,
  loginToWorker,
  saveConfig,
  tickSchedule,
  UI_APPLY_CONCURRENCY,
  type DueCheckResponse,
  type WorkerSession,
} from './lib/workerApi'
import {
  DEFAULT_SCHEDULE,
  type ApplyRunSummary,
  type DayKey,
  type DaySchedule,
  type DomainResult,
} from './types'
import './App.css'

const DEFAULT_WORKER_URL =
  import.meta.env.VITE_WORKER_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8787'

const TICK_INTERVAL_MS = 10_000

export default function App() {
  const [session, setSession] = useState<WorkerSession | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginLoading, setLoginLoading] = useState(false)

  const [schedule, setSchedule] = useState<DaySchedule[]>(DEFAULT_SCHEDULE)
  const [domains, setDomains] = useState<string[]>([])
  const [wildcard, setWildcard] = useState(true)
  const [timezone, setTimezone] = useState('Asia/Manila')
  const [applyTime, setApplyTime] = useState('00:00')
  const [todayTarget, setTodayTarget] = useState('')
  const [lastRun, setLastRun] = useState<ApplyRunSummary | null>(null)
  const [results, setResults] = useState<DomainResult[]>([])
  const [applying, setApplying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [scheduleStatus, setScheduleStatus] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [progress, setProgress] = useState<{
    completed: number
    total: number
    currentDomain?: string
  } | null>(null)
  const [liveRun, setLiveRun] = useState(false)

  const applyingRef = useRef(false)
  const savingRef = useRef(false)
  const payloadRef = useRef({
    schedule,
    domains,
    wildcard,
    timezone,
    applyTime,
  })
  payloadRef.current = { schedule, domains, wildcard, timezone, applyTime }

  const highlightDate = useMemo(() => new Date(), [])

  const runLiveApply = useCallback(
    async (
      activeSession: WorkerSession,
      opts: {
        domains: string[]
        targetUrl: string
        claimFingerprint?: string
        label: string
      },
    ) => {
      if (applyingRef.current) return null
      applyingRef.current = true
      setApplying(true)
      setLiveRun(true)

      const unique = Array.from(
        new Set(opts.domains.map((d) => d.trim()).filter(Boolean)),
      )
      const pending: DomainResult[] = unique.map((domain) => ({
        domain,
        status: 'pending',
      }))
      const nextResults = [...pending]
      const domainIndex = new Map(unique.map((d, i) => [d, i]))

      setResults(pending)
      setProgress({ completed: 0, total: unique.length })
      setTodayTarget(opts.targetUrl)
      setStatusMessage(
        `${opts.label} · Worker parallel ×${Math.min(UI_APPLY_CONCURRENCY, unique.length)} · 0/${unique.length}`,
      )
      setScheduleStatus(
        `${opts.label} · ${Math.min(UI_APPLY_CONCURRENCY, unique.length)} in flight on Worker…`,
      )

      try {
        const summary = await applyStream(activeSession, {
          claimFingerprint: opts.claimFingerprint,
          domains: unique,
          onEvent: (event) => {
            if (event.type === 'start') {
              setStatusMessage(
                `${opts.label} · Worker parallel ×${event.concurrency} · 0/${event.total}`,
              )
              setScheduleStatus(
                `${opts.label} · ${event.concurrency} Cloudflare calls in flight…`,
              )
              return
            }
            if (event.type === 'result') {
              const idx =
                domainIndex.get(event.result.domain) ?? event.index
              nextResults[idx] = event.result
              setResults([...nextResults])
              setProgress({
                completed: event.completed,
                total: event.total,
                currentDomain: `${event.concurrency} max in flight · ${event.result.domain}`,
              })
              setStatusMessage(
                `${opts.label} · parallel ×${event.concurrency} · ${event.completed}/${event.total}`,
              )
              setScheduleStatus(
                `Worker parallel 301 · ${event.completed}/${event.total}`,
              )
            }
          },
        })

        setLastRun(summary)
        setResults(summary.results)
        setTodayTarget(summary.targetUrl)
        setStatusMessage(
          `${opts.label} finished · ${summary.success} ok / ${summary.failed} failed → ${summary.targetUrl}`,
        )
        setScheduleStatus(
          `Finished ${summary.dayKey} → ${summary.targetUrl} (${summary.success} ok / ${summary.failed} fail)`,
        )
        return summary
      } finally {
        setProgress(null)
        setLiveRun(false)
        applyingRef.current = false
        setApplying(false)
      }
    },
    [],
  )

  const maybeStartDueApply = useCallback(
    async (
      activeSession: WorkerSession,
      due: DueCheckResponse,
      label: string,
    ) => {
      if (!due.due || applyingRef.current) {
        setScheduleStatus(due.reason)
        return
      }
      if (!due.domains.length) {
        setScheduleStatus(`${due.reason} · no old domains saved`)
        return
      }
      await runLiveApply(activeSession, {
        domains: due.domains,
        targetUrl: due.targetUrl,
        claimFingerprint: due.fingerprint,
        label,
      })
    },
    [runLiveApply],
  )

  const handleLogin = useCallback(
    async (workerUrl: string, adminSecret: string) => {
      setLoginLoading(true)
      setLoginError(null)
      try {
        const data = await loginToWorker(workerUrl, adminSecret)
        setSession({ workerUrl, adminSecret })
        setSchedule(
          data.config.schedule?.length ? data.config.schedule : DEFAULT_SCHEDULE,
        )
        setDomains(data.config.domains ?? [])
        setWildcard(data.config.wildcard ?? true)
        setTimezone(data.config.timezone || 'Asia/Manila')
        setApplyTime(data.config.applyTime || '00:00')
        setTodayTarget(data.today?.targetUrl ?? '')
        setLastRun(data.lastRun)
        setResults(data.lastRun?.results ?? [])
        setDirty(false)
        setStatusMessage(null)
        setScheduleStatus(null)
        return true
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setLoginLoading(false)
      }
    },
    [],
  )

  const logout = useCallback(() => {
    setSession(null)
    setResults([])
    setLastRun(null)
    setStatusMessage(null)
    setScheduleStatus(null)
    setDirty(false)
    setProgress(null)
    setLiveRun(false)
  }, [])

  const updateSchedule = useCallback((key: DayKey, targetUrl: string) => {
    setSchedule((prev) =>
      prev.map((day) => (day.key === key ? { ...day, targetUrl } : day)),
    )
    setDirty(true)
  }, [])

  const handleDomainsChange = useCallback((next: string[]) => {
    setDomains(next)
    setDirty(true)
  }, [])

  /** Save config only — never triggers 301. */
  const handleSave = useCallback(async () => {
    if (!session || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setStatusMessage(null)
    const payload = payloadRef.current
    try {
      const config = await saveConfig(session, payload)
      if (config.schedule?.length) setSchedule(config.schedule)
      setDomains(config.domains ?? payload.domains)
      setWildcard(config.wildcard ?? payload.wildcard)
      setTimezone(config.timezone)
      setApplyTime(config.applyTime || '00:00')
      const todayKey = [
        'sunday',
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
      ][new Date().getDay()] as DayKey
      const today = config.schedule?.find((d) => d.key === todayKey)
      if (today?.targetUrl) setTodayTarget(today.targetUrl)
      setDirty(false)
      setStatusMessage(
        `Saved · next auto at ${config.applyTime} ${config.timezone}`,
      )
      const due = await tickSchedule(session)
      setScheduleStatus(due.reason)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [session])

  // Schedule watcher only — 301 runs when Philippine time is due.
  useEffect(() => {
    if (!session || dirty) return

    let cancelled = false

    const runTick = async () => {
      if (cancelled || applyingRef.current || savingRef.current) return
      try {
        const due = await tickSchedule(session)
        if (cancelled) return
        if (due.due) {
          await maybeStartDueApply(session, due, 'Scheduled apply')
        } else {
          setScheduleStatus(due.reason)
        }
      } catch (error) {
        if (!cancelled) {
          setScheduleStatus(
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }

    void runTick()
    const id = window.setInterval(() => void runTick(), TICK_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [session, dirty, applyTime, timezone, maybeStartDueApply])

  if (!session) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        error={loginError}
        loading={loginLoading}
        defaultWorkerUrl={DEFAULT_WORKER_URL}
      />
    )
  }

  return (
    <div className="app-shell">
      <div className="app-atmosphere" aria-hidden="true" />

      <header className="topbar">
        <div className="topbar-brand">
          <p className="brand-mark">Bulk301</p>
          <span className="topbar-sub">Worker scheduler</span>
        </div>
        <div className="topbar-meta">
          <span className="account-chip">
            {applying
              ? '301 apply running… · '
              : dirty
                ? 'Unsaved changes · '
                : ''}
            {session.workerUrl}
          </span>
          <button type="button" className="ghost-btn" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="workspace">
        <div className="workspace-intro">
          <h1>Redirect schedule workspace</h1>
          <p>
            When Philippine time hits your schedule, all domains get 301s in
            parallel on the Worker (25 Cloudflare calls in flight; live stream
            updates this UI).
          </p>
        </div>

        <div className="workspace-grid">
          <div className="workspace-main">
            <PhilTimeClock
              timeZone={timezone || 'Asia/Manila'}
              applyTime={applyTime}
              autoWatchActive={!dirty && !applying}
              scheduleStatus={scheduleStatus}
            />
            <ScheduleEditor
              schedule={schedule}
              highlightDate={highlightDate}
              dirty={dirty}
              saving={saving}
              onChange={updateSchedule}
              onSave={() => void handleSave()}
            />
          </div>
          <div className="workspace-side">
            <ApplyControls
              schedule={schedule}
              wildcard={wildcard}
              onWildcardChange={(v) => {
                setWildcard(v)
                setDirty(true)
              }}
              timezone={timezone}
              onTimezoneChange={(v) => {
                setTimezone(v)
                setDirty(true)
              }}
              applyTime={applyTime}
              onApplyTimeChange={(v) => {
                setApplyTime(v)
                setDirty(true)
              }}
              applying={applying}
              saving={saving}
              onSave={() => void handleSave()}
              todayTarget={todayTarget}
              lastRun={lastRun}
              progressLabel={statusMessage}
              progress={progress}
            />
            <DomainUploader
              domains={domains}
              onChange={handleDomainsChange}
              disabled={applying || saving}
            />
          </div>
        </div>

        <ResultsPanel
          results={results}
          currentDomain={progress?.currentDomain}
          live={liveRun || applying}
        />
      </main>

      <footer className="app-footer">
        <span>Developed by Aris</span>
        <span>301s run on schedule only</span>
      </footer>
    </div>
  )
}
