import { useEffect, useState } from 'react'
import { fetchPublicViewer, type PublicViewerData } from '../lib/workerApi'
import { ResultsPanel } from './ResultsPanel'

/** Blank = same-origin via Vite `/api` proxy. */
const WORKER_URL =
  import.meta.env.VITE_WORKER_URL?.replace(/\/+$/, '') ?? ''

function readViewerToken(): string {
  try {
    const params = new URLSearchParams(window.location.search)
    return (params.get('t') || params.get('token') || '').trim()
  } catch {
    return ''
  }
}

export function PublicViewer() {
  const [token] = useState(() => readViewerToken())
  const [data, setData] = useState<PublicViewerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!token) {
        setError('Missing viewer token.')
        setLoading(false)
        return
      }
      try {
        const payload = await fetchPublicViewer(WORKER_URL, token)
        if (!cancelled) {
          setData(payload)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load viewer')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    const id = window.setInterval(() => {
      if (!token) return
      void fetchPublicViewer(WORKER_URL, token)
        .then((payload) => {
          if (!cancelled) {
            setData(payload)
            setError(null)
          }
        })
        .catch(() => {
          /* keep last good payload */
        })
    }, 30_000)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [token])

  const lastRun = data?.lastRun ?? null

  return (
    <div className="app-shell viewer-shell">
      <div className="app-atmosphere" aria-hidden="true" />
      <header className="command-bar viewer-bar">
        <div className="command-brand">
          <p className="brand-mark">Bulk301</p>
          <span className="run-pill">Viewer</span>
        </div>
      </header>

      <main className="workspace viewer-main">
        {loading ? (
          <p className="status-line">Loading…</p>
        ) : error ? (
          <p className="admin-banner error">{error}</p>
        ) : data ? (
          <>
            <section className="section apply-section viewer-summary">
              <div className="section-head">
                <div>
                  <h2>Status</h2>
                  <p>Read-only · auto-refreshes every 30s</p>
                </div>
              </div>

              <div className="apply-fields viewer-meta">
                <div className="field">
                  <span>Time</span>
                  <strong className="viewer-meta-value">{data.applyTime}</strong>
                </div>
                <div className="field">
                  <span>Timezone</span>
                  <strong className="viewer-meta-value">{data.timezone}</strong>
                </div>
              </div>

              <p className="viewer-wildcard">
                {data.wildcard
                  ? 'Preserve path & query: on'
                  : 'Preserve path & query: off'}
              </p>

              <div className="today-block">
                <span className="eyebrow">Today → {data.today.dayLabel}</span>
                <strong className="today-url">
                  {data.today.targetUrl || '—'}
                </strong>
              </div>

              {lastRun ? (
                <div className="last-run" role="status">
                  <span>
                    Last · {new Date(lastRun.ranAt).toLocaleString()}
                  </span>
                  <strong>
                    {lastRun.success} ok · {lastRun.failed} fail
                  </strong>
                </div>
              ) : (
                <p className="status-line">No apply run yet.</p>
              )}
            </section>

            {lastRun?.results?.length ? (
              <ResultsPanel results={lastRun.results} />
            ) : null}
          </>
        ) : null}
      </main>

      <footer className="app-footer">
        <span>Developed by Aris</span>
      </footer>
    </div>
  )
}
