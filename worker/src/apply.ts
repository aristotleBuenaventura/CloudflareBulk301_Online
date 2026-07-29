import {
  CloudflareApi,
  CloudflareApiException,
  pendingNote,
} from './cloudflareApi'
import { getTargetForDate } from './schedule'
import type { AppConfig, ApplyRunSummary, DomainResult } from './types'
import { uniqueDomains } from './types'

/** How many zone redirects to create at the same time. */
export const APPLY_CONCURRENCY = 25

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

export type ApplyTokenPair = {
  /** CLOUDFLARE_API_TOKEN — required when domains (account 1) is non-empty. */
  primary: string
  /** CLOUDFLARE_API_TOKEN_2 — required when domains2 is non-empty. */
  secondary: string | null
}

type WorkItem = {
  domain: string
  token: string | null
  account: 1 | 2
}

function buildWorkItems(
  config: AppConfig,
  tokens: ApplyTokenPair,
): WorkItem[] {
  const domains1 = uniqueDomains(config.domains)
  const domains2 = uniqueDomains(config.domains2)
  const items: WorkItem[] = [
    ...domains1.map((domain) => ({
      domain,
      token: tokens.primary,
      account: 1 as const,
    })),
    ...domains2.map((domain) => ({
      domain,
      token: tokens.secondary,
      account: 2 as const,
    })),
  ]
  return items
}

export async function applyScheduledRedirects(
  tokens: ApplyTokenPair,
  config: AppConfig,
  at = new Date(),
  onResult?: (result: DomainResult, index: number, completed: number) => void,
): Promise<ApplyRunSummary> {
  const { dayKey, day } = getTargetForDate(config, at)
  const targetUrl = day.targetUrl.trim()
  const work = buildWorkItems(config, tokens)

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

  if (work.length === 0) {
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
    work,
    APPLY_CONCURRENCY,
    async (item) => {
      if (!item.token) {
        return {
          domain: item.domain,
          status: 'failed' as const,
          message:
            item.account === 2
              ? 'CLOUDFLARE_API_TOKEN_2 is missing. Add it in worker/.dev.vars (or Worker secrets) for Account 2 domains.'
              : 'CLOUDFLARE_API_TOKEN is missing.',
        }
      }
      return applyOneDomain(item.token, config, item.domain, at)
    },
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
