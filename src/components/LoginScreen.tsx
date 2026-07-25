import { useEffect, useState, type FormEvent } from 'react'

interface LoginScreenProps {
  onLogin: (workerUrl: string, adminSecret: string) => Promise<boolean>
  error: string | null
  loading: boolean
  defaultWorkerUrl: string
}

export function LoginScreen({
  onLogin,
  error,
  loading,
  defaultWorkerUrl,
}: LoginScreenProps) {
  const [workerUrl, setWorkerUrl] = useState(defaultWorkerUrl)
  const [adminSecret, setAdminSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)

  useEffect(() => {
    setWorkerUrl(defaultWorkerUrl)
  }, [defaultWorkerUrl])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!workerUrl.trim() || !adminSecret.trim()) return
    await onLogin(workerUrl.trim().replace(/\/+$/, ''), adminSecret.trim())
  }

  return (
    <div className="login-page">
      <div className="login-atmosphere" aria-hidden="true" />
      <div className="login-shell">
        <header className="login-brand">
          <p className="brand-mark">Bulk301</p>
          <h1>Scheduled 301 redirects</h1>
          <p className="login-lede">
            Sign in with your Worker admin secret. The Cloudflare API token stays
            on the Worker as a secret — never in this browser.
          </p>
        </header>

        <form className="login-form" onSubmit={handleSubmit}>
          <label htmlFor="worker-url">Worker URL</label>
          <input
            id="worker-url"
            type="url"
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
            placeholder="http://127.0.0.1:8787"
            spellCheck={false}
            disabled={loading}
          />

          <label htmlFor="admin-secret">Admin secret</label>
          <div className="token-row">
            <input
              id="admin-secret"
              type={showSecret ? 'text' : 'password'}
              value={adminSecret}
              onChange={(e) => setAdminSecret(e.target.value)}
              placeholder="Same value as ADMIN_SECRET on the Worker"
              autoComplete="off"
              spellCheck={false}
              disabled={loading}
            />
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? 'Hide' : 'Show'}
            </button>
          </div>

          {error && <p className="form-error">{error}</p>}

          <button
            type="submit"
            className="primary-btn"
            disabled={loading || !workerUrl.trim() || !adminSecret.trim()}
          >
            {loading ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        <aside className="ip-panel">
          <h2>Automatic daily applies</h2>
          <p>
            Cron runs on the Worker every day (default: midnight Asia/Manila). It
            reads today&apos;s target from your weekly schedule and applies 301s
            for all saved old domains.
          </p>
          <p className="hint">
            Set secrets on your machine only:
            <br />
            <code>npx wrangler secret put CLOUDFLARE_API_TOKEN</code>
            <br />
            <code>npx wrangler secret put ADMIN_SECRET</code>
          </p>
        </aside>
      </div>
    </div>
  )
}
