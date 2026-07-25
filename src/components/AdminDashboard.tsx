import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  createAdminUser,
  deleteAdminUser,
  fetchAuditLog,
  listAdminUsers,
  resetAdminUserPassword,
  type AuditEvent,
  type ManagedUser,
  type WorkerSession,
} from '../lib/workerApi'
import { ThemeToggle } from './ThemeToggle'

interface AdminDashboardProps {
  session: WorkerSession
  onLogout: () => void | Promise<void>
}

type AuditTab = 'login' | 'redirect' | 'settings'

function formatWhen(value: string) {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatRelative(value: string | null | undefined) {
  if (!value) return null
  try {
    const ms = Date.now() - new Date(value).getTime()
    if (ms < 15_000) return 'just now'
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
    return formatWhen(value)
  } catch {
    return value
  }
}

function roleLabel(role: string) {
  return role === 'superadmin' ? 'Superadmin' : 'Admin'
}

function initials(email: string) {
  const parts = email.split(/[\s@._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
  }
  return email.slice(0, 2).toUpperCase() || '?'
}

function isLoginAction(action: string) {
  return (
    action.startsWith('login_') ||
    action.startsWith('2fa_') ||
    action === 'logout' ||
    action === 'session_idle_expired' ||
    action.startsWith('password_reset_')
  )
}

function isRedirectAction(action: string) {
  return action === 'apply_run'
}

function isSettingsAction(action: string) {
  return action === 'config_saved'
}

function actionLabel(action: string) {
  switch (action) {
    case 'login_success':
      return 'Login success'
    case 'login_failed':
      return 'Login failed'
    case 'login_locked':
      return 'Login locked'
    case 'login_rate_limited':
      return 'Rate limited'
    case 'login_ip_blocked':
      return 'IP blocked'
    case '2fa_required':
      return '2FA required'
    case '2fa_success':
      return '2FA success'
    case '2fa_failed':
      return '2FA failed'
    case '2fa_setup_started':
      return '2FA setup started'
    case '2fa_enabled':
      return '2FA enabled'
    case '2fa_disabled':
      return '2FA disabled'
    case 'logout':
      return 'Logout'
    case 'session_idle_expired':
      return 'Session idle expired'
    case 'apply_run':
      return 'Redirect applied'
    case 'config_saved':
      return 'Settings changed'
    case 'password_reset_requested':
      return 'Password reset requested'
    case 'password_reset_failed':
      return 'Password reset failed'
    case 'password_reset_success':
      return 'Password reset success'
    default:
      return action.replace(/_/g, ' ')
  }
}

function actorFromEvent(ev: AuditEvent): string | null {
  if (ev.actor) return ev.actor
  if (!ev.detail) return null
  const emailMatch = ev.detail.match(
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/,
  )
  return emailMatch?.[1]?.toLowerCase() || null
}

export function AdminDashboard({
  session,
  onLogout,
}: AdminDashboardProps) {
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [passwordEmail, setPasswordEmail] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [busyEmail, setBusyEmail] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null)

  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditRefreshing, setAuditRefreshing] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [auditTab, setAuditTab] = useState<AuditTab>('login')

  const loadUsers = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setRefreshing(true)
    try {
      const list = await listAdminUsers(session)
      setUsers(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [session])

  const loadAudit = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setAuditRefreshing(true)
    try {
      const events = await fetchAuditLog(session)
      setAuditEvents(events)
      setAuditError(null)
    } catch (err) {
      setAuditError(
        err instanceof Error ? err.message : 'Failed to load audit log',
      )
    } finally {
      setAuditLoading(false)
      setAuditRefreshing(false)
    }
  }, [session])

  useEffect(() => {
    void loadUsers()
    void loadAudit()
    const timer = window.setInterval(() => {
      void loadUsers({ quiet: true })
      void loadAudit({ quiet: true })
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [loadUsers, loadAudit])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    setNotice(null)
    setError(null)
    try {
      await createAdminUser(session, {
        email: email.trim(),
        password,
      })
      setEmail('')
      setPassword('')
      setNotice('Created admin account.')
      await loadUsers({ quiet: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create account')
    } finally {
      setCreating(false)
    }
  }

  async function onChangePassword(targetEmail: string) {
    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters.')
      return
    }
    setBusyEmail(targetEmail)
    setError(null)
    setNotice(null)
    try {
      await resetAdminUserPassword(session, targetEmail, newPassword)
      setPasswordEmail(null)
      setNewPassword('')
      setNotice(`Password updated for ${targetEmail}.`)
      await loadUsers({ quiet: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setBusyEmail(null)
    }
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return
    setBusyEmail(deleteTarget.email)
    setError(null)
    setNotice(null)
    try {
      await deleteAdminUser(session, deleteTarget.email)
      setNotice(`Deleted ${deleteTarget.email}.`)
      setDeleteTarget(null)
      await loadUsers({ quiet: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account')
    } finally {
      setBusyEmail(null)
    }
  }

  const adminCount = users.filter((u) => u.role === 'admin').length
  const superCount = users.filter((u) => u.role === 'superadmin').length
  const totpCount = users.filter((u) => u.totpEnabled).length
  const onlineCount = users.filter((u) => u.online).length
  const sortedUsers = [...users].sort((a, b) => {
    if (Boolean(a.online) !== Boolean(b.online)) {
      return a.online ? -1 : 1
    }
    return a.email.localeCompare(b.email)
  })

  const filteredAudit = useMemo(() => {
    return auditEvents.filter((ev) => {
      if (auditTab === 'login') return isLoginAction(ev.action)
      if (auditTab === 'redirect') return isRedirectAction(ev.action)
      return isSettingsAction(ev.action)
    })
  }, [auditEvents, auditTab])

  const loginCount = auditEvents.filter((e) => isLoginAction(e.action)).length
  const redirectCount = auditEvents.filter((e) =>
    isRedirectAction(e.action),
  ).length
  const settingsCount = auditEvents.filter((e) =>
    isSettingsAction(e.action),
  ).length

  return (
    <div className="app-shell admin-shell">
      <div className="app-atmosphere" aria-hidden="true" />

      <header className="command-bar">
        <div className="command-brand">
          <p className="brand-mark">Bulk301</p>
          <span className="run-pill">Admin</span>
        </div>

        <div className="admin-bar-lede">
          <strong>Admin Dashboard</strong>
          <span>Users · online · audit logs</span>
        </div>

        <div className="command-actions">
          <span className="role-badge role-superadmin">Superadmin</span>
          <span className="worker-chip" title={session.email}>
            {session.email}
          </span>
          <ThemeToggle compact />
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void onLogout()}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="workspace admin-main">
        <section className="admin-stats">
          <div className="admin-stat section accent">
            <span className="admin-stat-label">Online now</span>
            <strong>{onlineCount}</strong>
          </div>
          <div className="admin-stat section">
            <span className="admin-stat-label">Accounts</span>
            <strong>{users.length}</strong>
          </div>
          <div className="admin-stat section">
            <span className="admin-stat-label">With 2FA</span>
            <strong>{totpCount}</strong>
          </div>
          <div className="admin-stat section">
            <span className="admin-stat-label">Admins</span>
            <strong>{adminCount}</strong>
          </div>
          <div className="admin-stat section">
            <span className="admin-stat-label">Superadmins</span>
            <strong>{superCount}</strong>
          </div>
        </section>

        {error ? <p className="admin-banner error">{error}</p> : null}
        {notice ? <p className="admin-banner notice">{notice}</p> : null}

        <section className="admin-grid">
          <aside className="section admin-panel admin-create">
            <div className="section-head">
              <div>
                <h2>Add account</h2>
                <p>Create an admin. Superadmin cannot be created here.</p>
              </div>
            </div>
            <form className="admin-form" onSubmit={onCreate}>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="name@company.com"
                  autoComplete="off"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={12}
                  placeholder="At least 12 characters + letters & numbers"
                  autoComplete="new-password"
                />
              </label>
              <p className="admin-muted">
                New accounts must complete 2FA before using Bulk301.
              </p>
              <button
                type="submit"
                className="primary-btn"
                disabled={creating}
                style={{ width: '100%' }}
              >
                {creating ? 'Creating…' : 'Create admin'}
              </button>
            </form>
          </aside>

          <section className="section admin-panel admin-accounts">
            <div className="section-head">
              <div>
                <h2>Accounts</h2>
                <p>
                  Online status refreshes every 15 seconds
                  {onlineCount > 0 ? ` · ${onlineCount} online` : ''}.
                </p>
              </div>
              <button
                type="button"
                className="ghost-btn"
                disabled={refreshing}
                onClick={() => void loadUsers()}
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {loading && users.length === 0 ? (
              <div className="admin-empty">Loading accounts…</div>
            ) : users.length === 0 ? (
              <div className="admin-empty">No accounts yet.</div>
            ) : (
              <div className="admin-account-list">
                {sortedUsers.map((account) => {
                  const isSelf =
                    account.email === (session.email || '').toLowerCase()
                  const roleClass =
                    account.role === 'superadmin' ? 'superadmin' : 'admin'
                  const seenLabel = formatRelative(account.lastSeenAt)

                  return (
                    <article
                      key={account.email}
                      className={`admin-account-card${account.online ? ' is-online' : ''}`}
                    >
                      <div className="admin-account-top">
                        <div className="admin-account-identity">
                          <span
                            className={`admin-avatar tone-${roleClass}${account.online ? ' is-online' : ''}`}
                          >
                            {initials(account.email)}
                            <span
                              className={`presence-pip ${account.online ? 'is-online' : 'is-offline'}`}
                              title={account.online ? 'Online' : 'Offline'}
                              aria-hidden="true"
                            />
                          </span>
                          <div>
                            <div className="admin-account-name">
                              <strong>{account.email}</strong>
                              {isSelf ? (
                                <span className="admin-you">You</span>
                              ) : null}
                            </div>
                            <span className="admin-account-meta-line">
                              {account.online
                                ? `Online${seenLabel ? ` · ${seenLabel}` : ''}${
                                    account.lastSeenIp &&
                                    account.lastSeenIp !== 'unknown'
                                      ? ` · ${account.lastSeenIp}`
                                      : ''
                                  }`
                                : `Offline · Updated ${formatWhen(account.updatedAt)}`}
                            </span>
                          </div>
                        </div>
                        <div className="admin-account-meta">
                          <span
                            className={`status-dot ${account.online ? 'is-live' : 'is-offline'}`}
                          >
                            {account.online ? 'Online' : 'Offline'}
                          </span>
                          <span className={`role-badge role-${roleClass}`}>
                            {roleLabel(account.role)}
                          </span>
                          <span
                            className={`status-dot ${account.totpEnabled ? 'is-live' : 'is-warn'}`}
                          >
                            {account.totpEnabled ? '2FA on' : '2FA pending'}
                          </span>
                        </div>
                      </div>

                      <div className="admin-account-actions">
                        {passwordEmail === account.email ? (
                          <div className="admin-password-row">
                            <input
                              type="password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              placeholder="New password (12+ chars)"
                              autoComplete="new-password"
                            />
                            <button
                              type="button"
                              className="primary-btn"
                              disabled={busyEmail === account.email}
                              onClick={() =>
                                void onChangePassword(account.email)
                              }
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="ghost-btn"
                              onClick={() => {
                                setPasswordEmail(null)
                                setNewPassword('')
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            {(isSelf || account.role !== 'superadmin') && (
                              <button
                                type="button"
                                className="secondary-btn"
                                disabled={busyEmail === account.email}
                                onClick={() => {
                                  setPasswordEmail(account.email)
                                  setNewPassword('')
                                }}
                              >
                                Reset password
                              </button>
                            )}
                            {!isSelf && account.role !== 'superadmin' ? (
                              <button
                                type="button"
                                className="ghost-btn danger-btn"
                                disabled={busyEmail === account.email}
                                onClick={() => setDeleteTarget(account)}
                              >
                                Delete
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </section>

        <section className="section admin-panel admin-audit">
          <div className="section-head">
            <div>
              <h2>Audit logs</h2>
              <p>Filtered activity across logins, redirects, and settings.</p>
            </div>
            <button
              type="button"
              className="ghost-btn"
              disabled={auditRefreshing}
              onClick={() => void loadAudit()}
            >
              {auditRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="admin-audit-tabs" role="tablist" aria-label="Audit filters">
            <button
              type="button"
              role="tab"
              aria-selected={auditTab === 'login'}
              className={`admin-audit-tab${auditTab === 'login' ? ' is-active' : ''}`}
              onClick={() => setAuditTab('login')}
            >
              Login <span>{loginCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={auditTab === 'redirect'}
              className={`admin-audit-tab${auditTab === 'redirect' ? ' is-active' : ''}`}
              onClick={() => setAuditTab('redirect')}
            >
              Redirect <span>{redirectCount}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={auditTab === 'settings'}
              className={`admin-audit-tab${auditTab === 'settings' ? ' is-active' : ''}`}
              onClick={() => setAuditTab('settings')}
            >
              Change Settings <span>{settingsCount}</span>
            </button>
          </div>

          {auditError ? (
            <p className="admin-banner error">{auditError}</p>
          ) : null}

          {auditLoading && auditEvents.length === 0 ? (
            <div className="admin-empty">Loading audit log…</div>
          ) : filteredAudit.length === 0 ? (
            <div className="admin-empty">No events in this tab yet.</div>
          ) : (
            <ul className="admin-audit-list">
              {filteredAudit.map((ev) => {
                const actor = actorFromEvent(ev)
                return (
                  <li key={ev.id} className="admin-audit-item">
                    <div className="admin-audit-item-top">
                      <strong>{actionLabel(ev.action)}</strong>
                      <span>{formatWhen(ev.at)}</span>
                    </div>
                    <div className="admin-audit-item-meta">
                      {actor ? (
                        <span className="admin-audit-actor">{actor}</span>
                      ) : (
                        <span className="admin-audit-actor is-unknown">
                          Unknown user
                        </span>
                      )}
                      <span>{ev.ip}</span>
                    </div>
                    {ev.changes && ev.changes.length > 0 ? (
                      <ul className="admin-audit-changes">
                        {ev.changes.map((change) => (
                          <li key={`${ev.id}-${change}`}>{change}</li>
                        ))}
                      </ul>
                    ) : ev.detail ? (
                      <p className="admin-audit-detail">{ev.detail}</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </main>

      <footer className="app-footer">
        <span>Developed by Aris</span>
      </footer>

      {deleteTarget ? (
        <div className="admin-modal-backdrop" role="presentation">
          <div
            className="admin-modal section"
            role="dialog"
            aria-labelledby="delete-user-title"
          >
            <h3 id="delete-user-title">Delete account?</h3>
            <p>
              Remove <strong>{deleteTarget.email}</strong>? They will no longer
              be able to sign in.
            </p>
            <div className="admin-modal-actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={busyEmail === deleteTarget.email}
                onClick={() => void onConfirmDelete()}
              >
                Delete account
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
