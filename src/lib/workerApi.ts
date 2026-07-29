import type {
  AppConfig,
  ApplyRunSummary,
  DaySchedule,
  DomainResult,
} from '../types'

export type UserRole = 'superadmin' | 'admin'

export interface WorkerSession {
  /** Empty string = same-origin (Vite proxy / co-hosted). */
  workerUrl: string
  email?: string
  role?: UserRole
}

export interface ManagedUser {
  email: string
  role: UserRole
  totpEnabled: boolean
  createdAt: string
  updatedAt: string
  online?: boolean
  lastSeenAt?: string | null
  lastSeenIp?: string | null
}

export interface ConfigResponse {
  config: AppConfig
  today: { dayKey: string; targetUrl: string }
  lastRun: ApplyRunSummary | null
  totpEnabled?: boolean
  email?: string
  role?: UserRole
  canEdit?: boolean
}

export interface DueCheckResponse {
  ok: boolean
  due: boolean
  ran: boolean
  reason: string
  applyTime: string
  fingerprint: string
  targetUrl: string
  dayKey: string
  domains: string[]
  clock: {
    time: string
    date: string
    weekday: string
    timeZone: string
  }
  summary?: ApplyRunSummary
  reset?: boolean
}

export interface LoginResult {
  requires2fa: boolean
  requires2faSetup?: boolean
  challengeToken?: string
  totpEnabled?: boolean
  email?: string
}

export interface AuditEvent {
  id: string
  at: string
  action: string
  ip: string
  userAgent: string
  detail?: string
  actor?: string
  changes?: string[]
}

const jsonHeaders: HeadersInit = {
  'Content-Type': 'application/json',
}

function joinUrl(base: string, path: string): string {
  if (!base) return path
  return `${base.replace(/\/+$/, '')}${path}`
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // ignore
  }
  return `Request failed (HTTP ${response.status})`
}

async function apiFetch(
  workerUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(joinUrl(workerUrl, path), {
    ...init,
    credentials: 'include',
    headers: {
      ...jsonHeaders,
      ...(init.headers || {}),
    },
  })
}

export async function loginWithCredentials(
  workerUrl: string,
  email: string,
  password: string,
): Promise<LoginResult> {
  const response = await apiFetch(workerUrl, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as {
    requires2fa?: boolean
    requires2faSetup?: boolean
    challengeToken?: string
    totpEnabled?: boolean
    email?: string
  }
  return {
    requires2fa: Boolean(body.requires2fa),
    requires2faSetup: Boolean(body.requires2faSetup),
    challengeToken: body.challengeToken,
    totpEnabled: body.totpEnabled,
    email: body.email,
  }
}

export async function verify2fa(
  workerUrl: string,
  challengeToken: string,
  code: string,
): Promise<LoginResult> {
  const response = await apiFetch(workerUrl, '/api/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeToken, code }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as {
    totpEnabled?: boolean
    email?: string
    requires2faSetup?: boolean
  }
  return {
    requires2fa: false,
    totpEnabled: Boolean(body.totpEnabled),
    requires2faSetup: Boolean(body.requires2faSetup),
    email: body.email,
  }
}

export async function logoutWorker(session: WorkerSession): Promise<void> {
  await apiFetch(session.workerUrl, '/api/auth/logout', { method: 'POST' })
}

export async function heartbeatWorker(session: WorkerSession): Promise<void> {
  const response = await apiFetch(session.workerUrl, '/api/auth/heartbeat', {
    method: 'POST',
  })
  if (!response.ok) throw new Error(await parseError(response))
}

export async function fetchSessionMe(workerUrl: string): Promise<{
  authenticated: boolean
  totpEnabled: boolean
  requires2faSetup: boolean
  email: string
  role: UserRole
} | null> {
  const response = await apiFetch(workerUrl, '/api/auth/me')
  if (response.status === 401) return null
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as {
    authenticated?: boolean
    totpEnabled?: boolean
    requires2faSetup?: boolean
    email?: string
    role?: string
  }
  return {
    authenticated: Boolean(body.authenticated),
    totpEnabled: Boolean(body.totpEnabled),
    requires2faSetup: Boolean(body.requires2faSetup),
    email: body.email || '',
    role: body.role === 'superadmin' ? 'superadmin' : 'admin',
  }
}

export async function listAdminUsers(
  session: WorkerSession,
): Promise<ManagedUser[]> {
  const response = await apiFetch(session.workerUrl, '/api/admin/users')
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { users?: ManagedUser[] }
  return body.users || []
}

export async function createAdminUser(
  session: WorkerSession,
  input: { email: string; password: string },
): Promise<ManagedUser> {
  const response = await apiFetch(session.workerUrl, '/api/admin/users', {
    method: 'POST',
    // Role is forced to admin on the Worker; never send superadmin from the client.
    body: JSON.stringify({ ...input, role: 'admin' }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { user: ManagedUser }
  return body.user
}

export async function resetAdminUserPassword(
  session: WorkerSession,
  email: string,
  password: string,
): Promise<ManagedUser> {
  const response = await apiFetch(
    session.workerUrl,
    `/api/admin/users/${encodeURIComponent(email)}/password`,
    {
      method: 'POST',
      body: JSON.stringify({ password }),
    },
  )
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { user: ManagedUser }
  return body.user
}

export async function deleteAdminUser(
  session: WorkerSession,
  email: string,
): Promise<void> {
  const response = await apiFetch(
    session.workerUrl,
    `/api/admin/users/${encodeURIComponent(email)}`,
    { method: 'DELETE' },
  )
  if (!response.ok) throw new Error(await parseError(response))
}

export async function forceLogoutAdminUser(
  session: WorkerSession,
  email: string,
): Promise<{ email: string; revoked: number }> {
  const response = await apiFetch(
    session.workerUrl,
    `/api/admin/users/${encodeURIComponent(email)}/logout`,
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { email?: string; revoked?: number }
  return {
    email: body.email || email,
    revoked: body.revoked ?? 0,
  }
}

export async function forgotPassword(
  workerUrl: string,
  email: string,
): Promise<{ message: string; retryAfterSeconds: number }> {
  const response = await apiFetch(workerUrl, '/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    message?: string
    retryAfterSeconds?: number
  }
  if (!response.ok) {
    const err = new Error(body.error || `Request failed (HTTP ${response.status})`)
    ;(err as Error & { retryAfterSeconds?: number }).retryAfterSeconds =
      body.retryAfterSeconds
    throw err
  }
  return {
    message:
      body.message ||
      'If an account exists for that email, a password reset link has been sent.',
    retryAfterSeconds: Math.max(1, body.retryAfterSeconds ?? 120),
  }
}

export async function resetPassword(
  workerUrl: string,
  token: string,
  password: string,
): Promise<{ message: string }> {
  const response = await apiFetch(workerUrl, '/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { message?: string }
  return {
    message:
      body.message ||
      'Password updated. You can sign in with your new password.',
  }
}

export async function fetchConfig(
  session: WorkerSession,
): Promise<ConfigResponse> {
  const response = await apiFetch(session.workerUrl, '/api/config')
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as ConfigResponse
}

export async function start2faSetup(
  session: WorkerSession,
): Promise<{ secret: string; otpauthUrl: string }> {
  const response = await apiFetch(session.workerUrl, '/api/auth/2fa/setup/start', {
    method: 'POST',
  })
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as { secret: string; otpauthUrl: string }
}

export async function confirm2faSetup(
  session: WorkerSession,
  code: string,
): Promise<void> {
  const response = await apiFetch(
    session.workerUrl,
    '/api/auth/2fa/setup/confirm',
    {
      method: 'POST',
      body: JSON.stringify({ code }),
    },
  )
  if (!response.ok) throw new Error(await parseError(response))
}

export async function fetchAuditLog(
  session: WorkerSession,
): Promise<AuditEvent[]> {
  const response = await apiFetch(session.workerUrl, '/api/audit')
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { events: AuditEvent[] }
  return body.events || []
}

export async function saveConfig(
  session: WorkerSession,
  config: {
    schedule: DaySchedule[]
    domains: string[]
    domains2: string[]
    wildcard: boolean
    timezone?: string
    applyTime?: string
  },
): Promise<AppConfig> {
  const response = await apiFetch(session.workerUrl, '/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { config: AppConfig }
  return body.config
}

export async function tickSchedule(
  session: WorkerSession,
): Promise<DueCheckResponse> {
  const response = await apiFetch(session.workerUrl, '/api/tick', {
    method: 'POST',
    body: JSON.stringify({ checkOnly: true }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as DueCheckResponse
}

export async function applyStream(
  session: WorkerSession,
  opts: {
    claimFingerprint?: string
    domains: string[]
    onEvent: (event: ApplyStreamEvent) => void
  },
): Promise<ApplyRunSummary> {
  const response = await apiFetch(session.workerUrl, '/api/apply-stream', {
    method: 'POST',
    body: JSON.stringify({ claimFingerprint: opts.claimFingerprint }),
  })

  if (!response.ok) throw new Error(await parseError(response))
  if (!response.body) throw new Error('No response stream from Worker.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let summary: ApplyRunSummary | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const event = JSON.parse(trimmed) as ApplyStreamEvent
      opts.onEvent(event)
      if (event.type === 'done') summary = event.summary
      if (event.type === 'error') throw new Error(event.error)
    }
  }

  const tail = buffer.trim()
  if (tail) {
    const event = JSON.parse(tail) as ApplyStreamEvent
    opts.onEvent(event)
    if (event.type === 'done') summary = event.summary
    if (event.type === 'error') throw new Error(event.error)
  }

  if (!summary) throw new Error('Apply stream ended without a summary.')
  return summary
}

export async function fetchPublicViewer(
  workerUrl: string,
  token: string,
): Promise<PublicViewerData> {
  const params = new URLSearchParams({ t: token })
  // credentials: omit — viewer must not attach admin session cookies.
  const response = await fetch(
    joinUrl(workerUrl, `/api/public/viewer?${params.toString()}`),
    {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    },
  )
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as PublicViewerData
  // Defensive: ignore any unexpected write-related fields if a proxy tampers.
  return {
    ok: true,
    applyTime: String(body.applyTime || ''),
    timezone: String(body.timezone || ''),
    wildcard: Boolean(body.wildcard),
    today: {
      dayKey: String(body.today?.dayKey || ''),
      dayLabel: String(body.today?.dayLabel || ''),
      targetUrl: String(body.today?.targetUrl || ''),
    },
    lastRun: body.lastRun
      ? {
          ranAt: String(body.lastRun.ranAt || ''),
          dayKey: String(body.lastRun.dayKey || ''),
          targetUrl: String(body.lastRun.targetUrl || ''),
          success: Number(body.lastRun.success) || 0,
          skipped: Number(body.lastRun.skipped) || 0,
          failed: Number(body.lastRun.failed) || 0,
          results: Array.isArray(body.lastRun.results)
            ? body.lastRun.results.map((r) => ({
                domain: String(r.domain || ''),
                status: r.status,
                message: r.message ? String(r.message) : undefined,
              }))
            : [],
        }
      : null,
  }
}

export interface PublicViewerData {
  ok: true
  applyTime: string
  timezone: string
  wildcard: boolean
  today: {
    dayKey: string
    dayLabel: string
    targetUrl: string
  }
  lastRun: {
    ranAt: string
    dayKey: string
    targetUrl: string
    success: number
    skipped: number
    failed: number
    results: DomainResult[]
  } | null
}

export type ApplyStreamEvent =
  | {
      type: 'start'
      total: number
      concurrency: number
      targetUrl: string
      dayKey: string
    }
  | {
      type: 'result'
      index: number
      completed: number
      total: number
      concurrency: number
      result: DomainResult
    }
  | { type: 'done'; summary: ApplyRunSummary }
  | { type: 'error'; error: string }

export const UI_APPLY_CONCURRENCY = 25
