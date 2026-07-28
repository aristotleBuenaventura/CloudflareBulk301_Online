import type { AppConfig, ApplyRunSummary, DomainResult } from '../types'

const MAX_RESULTS = 250
const MAX_DOMAIN_LEN = 253
const MAX_MESSAGE_LEN = 280
const MAX_URL_LEN = 2048

const ALLOWED_STATUS = new Set(['pending', 'success', 'skipped', 'failed'])

/** Strip control chars / HTML-ish payloads for safe public display. */
export function sanitizePlainText(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>`"']/g, '')
    .trim()
    .slice(0, maxLen)
}

export function sanitizeDomain(value: unknown): string | null {
  const raw = sanitizePlainText(value, MAX_DOMAIN_LEN).toLowerCase()
  if (!raw) return null
  // Domains / hostnames only — no URLs, no path injection.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(raw) &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(raw)) {
    // Allow "(schedule)" style markers used by the app.
    if (/^\([a-z0-9 _.-]{1,40}\)$/i.test(String(value ?? '').trim())) {
      return sanitizePlainText(value, 40)
    }
    return null
  }
  return raw
}

export function sanitizeHttpUrl(value: unknown): string {
  const raw = sanitizePlainText(value, MAX_URL_LEN)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

function sanitizeResult(row: DomainResult): DomainResult | null {
  const domain = sanitizeDomain(row.domain)
  if (!domain) return null
  const status = ALLOWED_STATUS.has(row.status) ? row.status : 'failed'
  const message = row.message
    ? sanitizePlainText(row.message, MAX_MESSAGE_LEN)
    : undefined
  return {
    domain,
    status,
    message: message || undefined,
  }
}

export interface PublicViewerPayload {
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

const DAY_LABELS: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

export function buildPublicViewerPayload(
  config: AppConfig,
  lastRun: ApplyRunSummary | null,
  today: { dayKey: string; targetUrl: string; dayLabel?: string },
): PublicViewerPayload {
  const results = (lastRun?.results || [])
    .slice(0, MAX_RESULTS)
    .map(sanitizeResult)
    .filter((r): r is DomainResult => Boolean(r))

  return {
    ok: true,
    applyTime: sanitizePlainText(config.applyTime, 8),
    timezone: sanitizePlainText(config.timezone, 64) || 'Asia/Manila',
    wildcard: Boolean(config.wildcard),
    today: {
      dayKey: sanitizePlainText(today.dayKey, 16),
      dayLabel:
        sanitizePlainText(today.dayLabel, 32) ||
        DAY_LABELS[today.dayKey] ||
        today.dayKey,
      targetUrl: sanitizeHttpUrl(today.targetUrl),
    },
    lastRun: lastRun
      ? {
          ranAt: sanitizePlainText(lastRun.ranAt, 40),
          dayKey: sanitizePlainText(lastRun.dayKey, 16),
          targetUrl: sanitizeHttpUrl(lastRun.targetUrl),
          success: Math.max(0, Number(lastRun.success) || 0),
          skipped: Math.max(0, Number(lastRun.skipped) || 0),
          failed: Math.max(0, Number(lastRun.failed) || 0),
          results,
        }
      : null,
  }
}
