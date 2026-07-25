import type {
  AppConfig,
  ApplyRunSummary,
  DaySchedule,
  DomainResult,
} from '../types'

export interface WorkerSession {
  workerUrl: string
  adminSecret: string
}

export interface ConfigResponse {
  config: AppConfig
  today: { dayKey: string; targetUrl: string }
  lastRun: ApplyRunSummary | null
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

function authHeaders(secret: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Secret': secret,
  }
}

function joinUrl(base: string, path: string): string {
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

export async function loginToWorker(
  workerUrl: string,
  adminSecret: string,
): Promise<ConfigResponse> {
  const response = await fetch(joinUrl(workerUrl, '/api/config'), {
    headers: authHeaders(adminSecret),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as ConfigResponse
}

export async function saveConfig(
  session: WorkerSession,
  config: {
    schedule: DaySchedule[]
    domains: string[]
    wildcard: boolean
    timezone?: string
    applyTime?: string
  },
): Promise<AppConfig> {
  const response = await fetch(joinUrl(session.workerUrl, '/api/config'), {
    method: 'PUT',
    headers: authHeaders(session.adminSecret),
    body: JSON.stringify(config),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { config: AppConfig }
  return body.config
}

/** Check-only: does not apply. Used so the UI can show live progress. */
export async function tickSchedule(
  session: WorkerSession,
): Promise<DueCheckResponse> {
  const response = await fetch(joinUrl(session.workerUrl, '/api/tick'), {
    method: 'POST',
    headers: authHeaders(session.adminSecret),
    body: JSON.stringify({ checkOnly: true }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as DueCheckResponse
}

/** Clears auto marker, then returns due check (no bulk apply). */
export async function resetAutoAndTick(
  session: WorkerSession,
): Promise<DueCheckResponse> {
  const response = await fetch(joinUrl(session.workerUrl, '/api/reset-auto'), {
    method: 'POST',
    headers: authHeaders(session.adminSecret),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as DueCheckResponse
}

export async function claimAuto(
  session: WorkerSession,
  fingerprint: string,
): Promise<DueCheckResponse & { claimed: boolean }> {
  const response = await fetch(joinUrl(session.workerUrl, '/api/claim-auto'), {
    method: 'POST',
    headers: authHeaders(session.adminSecret),
    body: JSON.stringify({ fingerprint }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as DueCheckResponse & { claimed: boolean }
}

export async function applyOneDomain(
  session: WorkerSession,
  domain: string,
): Promise<DomainResult> {
  const response = await fetch(joinUrl(session.workerUrl, '/api/apply-one'), {
    method: 'POST',
    headers: authHeaders(session.adminSecret),
    body: JSON.stringify({ domain }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { result: DomainResult }
  return body.result
}

export async function finishApply(
  session: WorkerSession,
  results: DomainResult[],
  claimFingerprint?: string,
): Promise<ApplyRunSummary> {
  const response = await fetch(joinUrl(session.workerUrl, '/api/apply-finish'), {
    method: 'POST',
    headers: authHeaders(session.adminSecret),
    body: JSON.stringify({ results, claimFingerprint }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { summary: ApplyRunSummary }
  return body.summary
}
