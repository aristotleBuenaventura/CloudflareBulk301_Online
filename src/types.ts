export type DayKey =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

export interface DaySchedule {
  key: DayKey
  label: string
  short: string
  targetUrl: string
}

export type DomainResultStatus = 'pending' | 'success' | 'skipped' | 'failed'

export interface DomainResult {
  domain: string
  status: DomainResultStatus
  zoneId?: string
  message?: string
}

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

export interface AppConfig {
  schedule: DaySchedule[]
  /** Old domains for Cloudflare API token 1. */
  domains: string[]
  /** Old domains for Cloudflare API token 2. */
  domains2: string[]
  wildcard: boolean
  timezone: string
  /** Daily auto-apply time in timezone, "HH:MM". */
  applyTime: string
  updatedAt: string
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

export const DAY_KEYS_BY_JS: DayKey[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]
