import { useState, type FormEvent } from 'react'
import { ThemeToggle } from './ThemeToggle'

interface LoginScreenProps {
  onLogin: (email: string, password: string) => Promise<boolean>
  onVerify2fa: (challengeToken: string, code: string) => Promise<boolean>
  error: string | null
  loading: boolean
  challengeToken: string | null
}

export function LoginScreen({
  onLogin,
  onVerify2fa,
  error,
  loading,
  challengeToken,
}: LoginScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [code, setCode] = useState('')

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) return
    await onLogin(email.trim(), password)
  }

  async function handle2faSubmit(e: FormEvent) {
    e.preventDefault()
    if (!challengeToken || !code.trim()) return
    await onVerify2fa(challengeToken, code.trim())
  }

  const needs2fa = Boolean(challengeToken)

  return (
    <div className="login-page">
      <div className="login-atmosphere" aria-hidden="true" />
      <div className="login-top-actions">
        <ThemeToggle compact />
      </div>
      <div className="login-shell">
        <header className="login-brand">
          <p className="brand-mark">Bulk301</p>
          <p className="login-lede">
            {needs2fa
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Sign in with email and password. New accounts must set up 2FA next.'}
          </p>
        </header>

        {needs2fa ? (
          <form className="login-form" onSubmit={handle2faSubmit}>
            <label className="field" htmlFor="totp-code">
              <span>Authenticator code</span>
              <input
                id="totp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                disabled={loading}
                maxLength={8}
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button
              type="submit"
              className="primary-btn login-submit"
              disabled={loading || code.trim().length < 6}
            >
              {loading ? 'Verifying…' : 'Verify 2FA'}
            </button>
          </form>
        ) : (
          <form className="login-form" onSubmit={handlePasswordSubmit}>
            <label className="field" htmlFor="email">
              <span>Email</span>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                disabled={loading}
              />
            </label>

            <label className="field" htmlFor="password">
              <span>Password</span>
              <div className="token-row">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>

            {error && <p className="form-error">{error}</p>}

            <button
              type="submit"
              className="primary-btn login-submit"
              disabled={loading || !email.trim() || !password}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
