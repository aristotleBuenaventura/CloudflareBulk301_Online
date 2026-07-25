export type DayKey =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

export interface CloudflareUser {
  email: string
  id: string
  isAccountToken: boolean
}

export interface CloudflareZone {
  id: string
  name: string
  status: string
}

export interface RedirectCreateResult {
  created: boolean
  message: string
}

export interface DaySchedule {
  key: DayKey
  label: string
  short: string
  targetUrl: string
}

export interface AppConfig {
  schedule: DaySchedule[]
  domains: string[]
  wildcard: boolean
  timezone: string
  /** Daily auto-apply time in `timezone`, 24h "HH:MM" (e.g. "00:00", "14:30"). */
  applyTime: string
  updatedAt: string
}

export type DomainResultStatus = 'pending' | 'success' | 'skipped' | 'failed'

export interface DomainResult {
  domain: string
  status: DomainResultStatus
  zoneId?: string
  message?: string
}

export interface ApplyRunSummary {
  ranAt: string
  timezone: string
  dayKey: DayKey
  targetUrl: string
  success: number
  skipped: number
  failed: number
  results: DomainResult[]
}

export const DEFAULT_SCHEDULE: DaySchedule[] = [
  { key: 'monday', label: 'Monday', short: 'Mon', targetUrl: 'https://ga888tructiep.org' },
  { key: 'tuesday', label: 'Tuesday', short: 'Tue', targetUrl: 'https://ga888tructiep.net' },
  { key: 'wednesday', label: 'Wednesday', short: 'Wed', targetUrl: 'https://ga888tructiep.app' },
  { key: 'thursday', label: 'Thursday', short: 'Thu', targetUrl: 'https://ga888tructiep.tech' },
  { key: 'friday', label: 'Friday', short: 'Fri', targetUrl: 'https://ga888tructiep.dev' },
  { key: 'saturday', label: 'Saturday', short: 'Sat', targetUrl: 'https://ga888tructiep.us' },
  { key: 'sunday', label: 'Sunday', short: 'Sun', targetUrl: 'https://ga888tructiep.biz' },
]

export function normalizeApplyTime(value: string | undefined | null): string {
  const raw = (value ?? '00:00').trim()
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw)
  if (!match) return '00:00'
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

export function defaultConfig(timezone = 'Asia/Manila'): AppConfig {
  return {
    schedule: DEFAULT_SCHEDULE,
    domains: [],
    wildcard: true,
    timezone,
    applyTime: '00:00',
    updatedAt: new Date().toISOString(),
  }
}
