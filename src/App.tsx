import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdminDashboard } from './components/AdminDashboard'
import { ApplyControls } from './components/ApplyControls'
import { DomainUploader } from './components/DomainUploader'
import { LoginScreen } from './components/LoginScreen'
import { PhilTimeClock } from './components/PhilTimeClock'
import { PublicViewer } from './components/PublicViewer'
import { ResultsPanel } from './components/ResultsPanel'
import { ScheduleEditor } from './components/ScheduleEditor'
import { SecurityPanel } from './components/SecurityPanel'
import {
  applyStream,
  fetchConfig,
  fetchSessionMe,
  heartbeatWorker,
  loginWithCredentials,
  logoutWorker,
  saveConfig,
  tickSchedule,
  UI_APPLY_CONCURRENCY,
  verify2fa,
  type DueCheckResponse,
  type UserRole,
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

/** Blank = same-origin via Vite `/api` proxy. Set VITE_WORKER_URL only if UI ≠ Worker host. */
const WORKER_URL =
  import.meta.env.VITE_WORKER_URL?.replace(/\/+$/, '') ?? ''

const TICK_INTERVAL_MS = 10_000

function isViewerPath(): boolean {
  try {
    const path = window.location.pathname.replace(/\/+$/, '') || '/'
    return path === '/viewer'
  } catch {
    return false
  }
}

export default function App() {
  if (isViewerPath()) {
    return <PublicViewer />
  }
  return <MainApp />
}

function MainApp() {
  const [session, setSession] = useState<WorkerSession | null>(null)
  const [role, setRole] = useState<UserRole>('admin')
  const [totpEnabled, setTotpEnabled] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [loginLoading, setLoginLoading] = useState(false)
  const [challengeToken, setChallengeToken] = useState<string | null>(null)
  const [resetToken, setResetToken] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('resetToken')
    } catch {
      return null
    }
  })
  const [booting, setBooting] = useState(true)

  const [schedule, setSchedule] = useState<DaySchedule[]>(DEFAULT_SCHEDULE)
  const [domains, setDomains] = useState<string[]>([])
  const [domains2, setDomains2] = useState<string[]>([])
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
    domains2,
    wildcard,
    timezone,
    applyTime,
  })
  payloadRef.current = {
    schedule,
    domains,
    domains2,
    wildcard,
    timezone,
    applyTime,
  }

  const highlightDate = useMemo(() => new Date(), [])

  const applyConfigToState = useCallback(
    (data: Awaited<ReturnType<typeof fetchConfig>>) => {
      setSchedule(
        data.config.schedule?.length ? data.config.schedule : DEFAULT_SCHEDULE,
      )
      setDomains(data.config.domains ?? [])
      setDomains2(data.config.domains2 ?? [])
      setWildcard(data.config.wildcard ?? true)
      setTimezone(data.config.timezone || 'Asia/Manila')
      setApplyTime(data.config.applyTime || '00:00')
      setTodayTarget(data.today?.targetUrl ?? '')
      setLastRun(data.lastRun)
      setResults(data.lastRun?.results ?? [])
      setTotpEnabled(Boolean(data.totpEnabled))
      setDirty(false)
      setStatusMessage(null)
      setScheduleStatus(null)
    },
    [],
  )

  // Restore cookie session on load (no secrets in localStorage).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const me = await fetchSessionMe(WORKER_URL)
        if (cancelled) return
        if (me?.authenticated) {
          setSession({
            workerUrl: WORKER_URL,
            email: me.email,
            role: me.role,
          })
          setRole(me.role)
          setTotpEnabled(me.totpEnabled)
          if (me.totpEnabled && me.role !== 'superadmin') {
            const data = await fetchConfig({ workerUrl: WORKER_URL })
            if (cancelled) return
            applyConfigToState(data)
          }
        }
      } catch {
        /* not signed in */
      } finally {
        if (!cancelled) setBooting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyConfigToState])

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
              const idx = domainIndex.get(event.result.domain) ?? event.index
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

  const enterApp = useCallback(
    async (email?: string) => {
      const me = await fetchSessionMe(WORKER_URL)
      if (!me?.authenticated) {
        throw new Error('Session missing after login.')
      }
      setSession({
        workerUrl: WORKER_URL,
        email: email || me.email,
        role: me.role,
      })
      setRole(me.role)
      setTotpEnabled(me.totpEnabled)
      setChallengeToken(null)
      if (me.totpEnabled && me.role !== 'superadmin') {
        const data = await fetchConfig({ workerUrl: WORKER_URL })
        applyConfigToState(data)
      }
    },
    [applyConfigToState],
  )

  const handleLogin = useCallback(
    async (email: string, password: string) => {
      setLoginLoading(true)
      setLoginError(null)
      try {
        const result = await loginWithCredentials(WORKER_URL, email, password)
        if (result.requires2fa && result.challengeToken) {
          setChallengeToken(result.challengeToken)
          return false
        }
        await enterApp(result.email || email)
        setLoginNotice(null)
        return true
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setLoginLoading(false)
      }
    },
    [enterApp],
  )

  const handleVerify2fa = useCallback(
    async (token: string, code: string) => {
      setLoginLoading(true)
      setLoginError(null)
      try {
        const result = await verify2fa(WORKER_URL, token, code)
        await enterApp(result.email)
        setLoginNotice(null)
        return true
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setLoginLoading(false)
      }
    },
    [enterApp],
  )

  const logout = useCallback(async () => {
    if (session) {
      try {
        await logoutWorker(session)
      } catch {
        /* ignore */
      }
    }
    setSession(null)
    setRole('admin')
    setTotpEnabled(false)
    setResults([])
    setLastRun(null)
    setStatusMessage(null)
    setScheduleStatus(null)
    setDirty(false)
    setProgress(null)
    setLiveRun(false)
    setChallengeToken(null)
  }, [session])

  // Keep presence fresh while the tab is open (admin online list).
  useEffect(() => {
    if (!session) return
    let cancelled = false
    const ping = async () => {
      try {
        await heartbeatWorker(session)
      } catch {
        /* session expiry handled by other calls */
      }
    }
    void ping()
    const id = window.setInterval(() => {
      if (!cancelled) void ping()
    }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [session])

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

  const handleDomains2Change = useCallback((next: string[]) => {
    setDomains2(next)
    setDirty(true)
  }, [])

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
      setDomains2(config.domains2 ?? payload.domains2)
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
      const msg = error instanceof Error ? error.message : String(error)
      setStatusMessage(msg)
      if (/unauthorized|sign in|expired/i.test(msg)) {
        setSession(null)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [session])

  useEffect(() => {
    if (!session || dirty || !totpEnabled || role === 'superadmin') return

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
          const msg = error instanceof Error ? error.message : String(error)
          setScheduleStatus(msg)
          if (/unauthorized|sign in|expired/i.test(msg)) {
            setSession(null)
          }
        }
      }
    }

    void runTick()
    const id = window.setInterval(() => void runTick(), TICK_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [session, dirty, applyTime, timezone, maybeStartDueApply, totpEnabled, role])

  if (booting) {
    return (
      <div className="login-page">
        <div className="login-atmosphere" aria-hidden="true" />
        <p className="login-lede" style={{ position: 'relative', zIndex: 1 }}>
          Checking session…
        </p>
      </div>
    )
  }

  if (!session) {
    return (
      <LoginScreen
        workerUrl={WORKER_URL}
        onLogin={handleLogin}
        onVerify2fa={handleVerify2fa}
        error={loginError}
        notice={loginNotice}
        loading={loginLoading}
        challengeToken={challengeToken}
        resetToken={resetToken}
        onClearResetToken={() => {
          setResetToken(null)
          const url = new URL(window.location.href)
          url.searchParams.delete('resetToken')
          window.history.replaceState({}, '', url.pathname + url.search)
        }}
      />
    )
  }

  const runState = applying ? 'running' : dirty ? 'dirty' : 'idle'

  if (!totpEnabled) {
    return (
      <div className="app-shell is-dirty">
        <div className="app-atmosphere" aria-hidden="true" />
        <header className="command-bar">
          <div className="command-brand">
            <p className="brand-mark">Bulk301</p>
            <span className="run-pill is-dirty">2FA required</span>
          </div>
          <div className="command-actions">
            <span className="worker-chip">{session.email}</span>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void logout()}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="workspace" style={{ maxWidth: 560 }}>
          <SecurityPanel
            session={session}
            totpEnabled={false}
            mandatorySetup
            onTotpChange={async (enabled) => {
              setTotpEnabled(enabled)
              if (enabled && role !== 'superadmin') {
                const data = await fetchConfig(session)
                applyConfigToState(data)
              }
            }}
          />
        </main>
        <footer className="app-footer">
          <span>Developed by Aris</span>
        </footer>
      </div>
    )
  }

  if (role === 'superadmin') {
    return <AdminDashboard session={session} onLogout={logout} />
  }

  return (
    <div className={`app-shell is-${runState}`}>
      <div className="app-atmosphere" aria-hidden="true" />

      <header className="command-bar">
        <div className="command-brand">
          <p className="brand-mark">Bulk301</p>
          <span className={`run-pill is-${runState}`} title={session.email}>
            {applying ? 'Applying 301s' : dirty ? 'Unsaved' : 'Armed'}
          </span>
        </div>

        <PhilTimeClock
          compact
          timeZone={timezone || 'Asia/Manila'}
          applyTime={applyTime}
          autoWatchActive={!dirty && !applying}
          scheduleStatus={scheduleStatus}
        />

        <div className="command-actions">
          <span className="worker-chip" title={session.email}>
            {session.email}
          </span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="workspace">
        <div className="workspace-grid">
          <ScheduleEditor
            schedule={schedule}
            highlightDate={highlightDate}
            dirty={dirty}
            saving={saving}
            onChange={updateSchedule}
            onSave={() => void handleSave()}
          />
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
        </div>

        <DomainUploader
          title="Account 1 · Old domains"
          description="CSV / paste for CLOUDFLARE_API_TOKEN (first Cloudflare account)"
          domains={domains}
          onChange={handleDomainsChange}
          disabled={applying || saving}
        />

        <DomainUploader
          title="Account 2 · Old domains"
          description="CSV / paste for CLOUDFLARE_API_TOKEN_2 (second Cloudflare account)"
          domains={domains2}
          onChange={handleDomains2Change}
          disabled={applying || saving}
        />

        <ResultsPanel
          results={results}
          currentDomain={progress?.currentDomain}
          live={liveRun || applying}
        />
      </main>

      <footer className="app-footer">
        <span>Developed by Aris</span>
      </footer>
    </div>
  )
}
