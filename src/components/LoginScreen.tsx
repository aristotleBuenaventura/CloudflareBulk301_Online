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
          <p className="login-lede">
            Connect to your Worker. Cloudflare token stays server-side.
          </p>
        </header>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="field" htmlFor="worker-url">
            <span>Worker URL</span>
            <input
              id="worker-url"
              type="url"
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="http://127.0.0.1:8787"
              spellCheck={false}
              disabled={loading}
            />
          </label>

          <label className="field" htmlFor="admin-secret">
            <span>Admin secret</span>
            <div className="token-row">
              <input
                id="admin-secret"
                type={showSecret ? 'text' : 'password'}
                value={adminSecret}
                onChange={(e) => setAdminSecret(e.target.value)}
                placeholder="ADMIN_SECRET"
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
          </label>

          {error && <p className="form-error">{error}</p>}

          <button
            type="submit"
            className="primary-btn login-submit"
            disabled={loading || !workerUrl.trim() || !adminSecret.trim()}
          >
            {loading ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  )
}
