import {
  CloudflareApi,
  CloudflareApiException,
  pendingNote,
} from './cloudflareApi'
import { getTargetForDate } from './schedule'
import type { AppConfig, ApplyRunSummary, DomainResult } from './types'

/** How many zone redirects to create at the same time. */
export const APPLY_CONCURRENCY = 15

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number, completed: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  let completed = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      const result = await fn(items[i], i)
      results[i] = result
      completed++
      onResult?.(result, i, completed)
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: poolSize }, () => worker()))
  return results
}

export async function applyOneDomain(
  apiToken: string,
  config: AppConfig,
  domain: string,
  at = new Date(),
): Promise<DomainResult> {
  const { day } = getTargetForDate(config, at)
  const targetUrl = day.targetUrl.trim()
  const source = domain.trim()

  if (!targetUrl) {
    return {
      domain: source || '(schedule)',
      status: 'failed',
      message: `No target URL set for ${day.label}.`,
    }
  }

  if (!source) {
    return {
      domain: '(empty)',
      status: 'failed',
      message: 'Empty domain.',
    }
  }

  const api = new CloudflareApi(apiToken)
  try {
    const zone = await api.findZone(source)
    if (!zone) {
      return {
        domain: source,
        status: 'failed',
        message:
          `Zone not found for "${source}". Check domain is on Cloudflare ` +
          'and the token includes All zones.',
      }
    }

    const result = await api.createFullDomainRedirect({
      zoneId: zone.id,
      sourceDomain: source,
      targetBaseUrl: targetUrl,
      wildcard: config.wildcard,
    })
    let message = result.message
    const note = pendingNote(zone)
    if (note) message = `${message}\n${note}`
    return {
      domain: source,
      status: result.created ? 'success' : 'skipped',
      zoneId: zone.id,
      message,
    }
  } catch (error) {
    return {
      domain: source,
      status: 'failed',
      message:
        error instanceof CloudflareApiException
          ? error.message
          : String(error),
    }
  }
}

export async function applyScheduledRedirects(
  apiToken: string,
  config: AppConfig,
  at = new Date(),
  onResult?: (result: DomainResult, index: number, completed: number) => void,
): Promise<ApplyRunSummary> {
  const { dayKey, day } = getTargetForDate(config, at)
  const targetUrl = day.targetUrl.trim()
  const domains = Array.from(
    new Set(config.domains.map((d) => d.trim()).filter(Boolean)),
  )

  if (!targetUrl) {
    return {
      ranAt: at.toISOString(),
      timezone: config.timezone,
      dayKey,
      targetUrl: '',
      success: 0,
      skipped: 0,
      failed: 1,
      results: [
        {
          domain: '(schedule)',
          status: 'failed',
          message: `No target URL set for ${day.label}.`,
        },
      ],
    }
  }

  if (domains.length === 0) {
    return {
      ranAt: at.toISOString(),
      timezone: config.timezone,
      dayKey,
      targetUrl,
      success: 0,
      skipped: 0,
      failed: 0,
      results: [],
    }
  }

  const results = await mapPool(
    domains,
    APPLY_CONCURRENCY,
    (domain) => applyOneDomain(apiToken, config, domain, at),
    onResult,
  )

  return {
    ranAt: at.toISOString(),
    timezone: config.timezone,
    dayKey,
    targetUrl,
    success: results.filter((r) => r.status === 'success').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  }
}

export function summarizeResults(
  config: AppConfig,
  results: DomainResult[],
  at = new Date(),
): ApplyRunSummary {
  const { dayKey, day } = getTargetForDate(config, at)
  return {
    ranAt: at.toISOString(),
    timezone: config.timezone,
    dayKey,
    targetUrl: day.targetUrl.trim(),
    success: results.filter((r) => r.status === 'success').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  }
}
