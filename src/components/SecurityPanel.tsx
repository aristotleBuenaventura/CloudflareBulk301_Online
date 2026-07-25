import { useEffect, useState, type FormEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  confirm2faSetup,
  fetchAuditLog,
  start2faSetup,
  type AuditEvent,
  type WorkerSession,
} from '../lib/workerApi'

interface SecurityPanelProps {
  session: WorkerSession
  totpEnabled: boolean
  mandatorySetup?: boolean
  onTotpChange: (enabled: boolean) => void | Promise<void>
}

export function SecurityPanel({
  session,
  totpEnabled,
  mandatorySetup = false,
  onTotpChange,
}: SecurityPanelProps) {
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<AuditEvent[]>([])

  async function refreshAudit() {
    if (!totpEnabled) return
    try {
      const list = await fetchAuditLog(session)
      setEvents(list)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void refreshAudit()
  }, [session.workerUrl, totpEnabled])

  useEffect(() => {
    if (mandatorySetup && !totpEnabled && !secret && !busy) {
      void handleStartSetup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mandatorySetup, totpEnabled])

  async function handleStartSetup() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const data = await start2faSetup(session)
      setOtpauthUrl(data.otpauthUrl)
      setSecret(data.secret)
      setMessage(
        'Scan the QR code with your authenticator app, then enter a code to finish.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirmSetup(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await confirm2faSetup(session, code.trim())
      setOtpauthUrl(null)
      setSecret(null)
      setCode('')
      await onTotpChange(true)
      setMessage('2FA enabled. You can use Bulk301 now.')
      await refreshAudit()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className={`section security-section ${mandatorySetup ? 'is-mandatory' : ''}`}
    >
      <div className="section-head">
        <div>
          <h2>{mandatorySetup ? 'Set up 2FA to continue' : 'Security'}</h2>
          <p>
            {mandatorySetup
              ? `${session.email || 'Account'} · required before schedule / 301`
              : 'HttpOnly session · mandatory 2FA · audit log'}
          </p>
        </div>
        <span className={`status-dot ${totpEnabled ? 'is-live' : 'is-warn'}`}>
          {totpEnabled ? '2FA on' : '2FA required'}
        </span>
      </div>

      {!totpEnabled && (
        <div className="security-block">
          {!secret ? (
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() => void handleStartSetup()}
            >
              {busy ? 'Starting…' : 'Generate authenticator secret'}
            </button>
          ) : (
            <form className="security-form" onSubmit={handleConfirmSetup}>
              <p className="status-line">
                Scan with Google Authenticator / 1Password / Authy:
              </p>
              {otpauthUrl && (
                <div className="totp-qr-wrap">
                  <QRCodeSVG
                    value={otpauthUrl}
                    size={196}
                    level="M"
                    marginSize={2}
                    title="Bulk301 2FA QR code"
                  />
                  <p className="totp-qr-hint">Bulk301 · {session.email}</p>
                </div>
              )}
              <p className="status-line">Or enter this key manually:</p>
              <code className="secret-box">{secret}</code>
              {otpauthUrl && (
                <a className="otpauth-link" href={otpauthUrl}>
                  Open otpauth link
                </a>
              )}
              <label className="field">
                <span>Confirm code</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  disabled={busy}
                />
              </label>
              <button
                type="submit"
                className="primary-btn"
                disabled={busy || code.trim().length < 6}
              >
                Enable 2FA &amp; continue
              </button>
            </form>
          )}
        </div>
      )}

      {totpEnabled && !mandatorySetup && (
        <p className="status-line">
          2FA is required and enabled for {session.email}. Recovery reset needs
          ADMIN_SECRET via Worker API.
        </p>
      )}

      {message && <p className="status-line">{message}</p>}
      {error && <p className="form-error">{error}</p>}

      {totpEnabled && !mandatorySetup && (
        <div className="audit-block">
          <div className="section-head">
            <h2>Audit log</h2>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void refreshAudit()}
            >
              Refresh
            </button>
          </div>
          {events.length === 0 ? (
            <p className="status-line">No events yet.</p>
          ) : (
            <ul className="audit-list">
              {events.slice(0, 40).map((ev) => (
                <li key={ev.id}>
                  <strong>{ev.action}</strong>
                  <span>{new Date(ev.at).toLocaleString()}</span>
                  <span>{ev.ip}</span>
                  {ev.detail && <span className="audit-detail">{ev.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
