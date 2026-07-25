import {
  applyOneDomain,
  applyScheduledRedirects,
  summarizeResults,
} from './apply'
import {
  isPlaceholderApiToken,
  normalizeApiToken,
} from './cloudflareApi'
import {
  formatPhilippineClock,
  getTargetForDate,
  shouldRunScheduledApply,
} from './schedule'
import {
  defaultConfig,
  normalizeApplyTime,
  type AppConfig,
  type ApplyRunSummary,
  type DaySchedule,
  type DomainResult,
} from './types'

export interface Env {
  CONFIG: KVNamespace
  CLOUDFLARE_API_TOKEN: string
  ADMIN_SECRET: string
  TIMEZONE: string
}

const CONFIG_KEY = 'app_config'
const LAST_RUN_KEY = 'last_run'
const LAST_AUTO_KEY = 'last_auto_fingerprint'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}

function unauthorized(): Response {
  return json({ error: 'Unauthorized. Provide ADMIN_SECRET.' }, 401)
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_SECRET
  if (!expected) return false

  const header =
    request.headers.get('X-Admin-Secret') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')

  return header === expected
}

async function readConfig(env: Env): Promise<AppConfig> {
  const raw = await env.CONFIG.get(CONFIG_KEY)
  if (!raw) {
    return defaultConfig(env.TIMEZONE || 'Asia/Manila')
  }
  try {
    const parsed = JSON.parse(raw) as AppConfig
    const base = defaultConfig(env.TIMEZONE || 'Asia/Manila')
    return {
      ...base,
      ...parsed,
      timezone: parsed.timezone || env.TIMEZONE || 'Asia/Manila',
      applyTime: normalizeApplyTime(parsed.applyTime ?? base.applyTime),
    }
  } catch {
    return defaultConfig(env.TIMEZONE || 'Asia/Manila')
  }
}

async function writeConfig(env: Env, config: AppConfig): Promise<void> {
  await env.CONFIG.put(CONFIG_KEY, JSON.stringify(config))
}

function normalizeConfigInput(
  body: Partial<AppConfig>,
  current: AppConfig,
  fallbackTz: string,
): AppConfig {
  const schedule = Array.isArray(body.schedule)
    ? (body.schedule as DaySchedule[])
    : current.schedule
  const domains = Array.isArray(body.domains)
    ? Array.from(
        new Set(
          body.domains
            .map((d) => String(d).trim())
            .filter(Boolean),
        ),
      )
    : current.domains

  return {
    schedule,
    domains,
    wildcard: typeof body.wildcard === 'boolean' ? body.wildcard : current.wildcard,
    timezone: body.timezone?.trim() || current.timezone || fallbackTz,
    applyTime: normalizeApplyTime(
      body.applyTime !== undefined ? body.applyTime : current.applyTime,
    ),
    updatedAt: new Date().toISOString(),
  }
}

async function requireToken(env: Env): Promise<string> {
  const token = normalizeApiToken(env.CLOUDFLARE_API_TOKEN || '')
  if (!token || isPlaceholderApiToken(token)) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN is missing or still a placeholder in worker/.dev.vars. ' +
        'Paste a real Cloudflare API Token, save the file, restart wrangler dev, then try again.',
    )
  }
  return token
}

async function checkDue(env: Env): Promise<{
  due: boolean
  ran: boolean
  reason: string
  clock: ReturnType<typeof formatPhilippineClock>
  applyTime: string
  fingerprint: string
  targetUrl: string
  dayKey: string
  domains: string[]
}> {
  const config = await readConfig(env)
  const clock = formatPhilippineClock(new Date(), config.timezone)
  const lastAuto = await env.CONFIG.get(LAST_AUTO_KEY)
  const check = shouldRunScheduledApply(config, lastAuto)
  const domains = Array.from(
    new Set(config.domains.map((d) => d.trim()).filter(Boolean)),
  )
  const { dayKey } = getTargetForDate(config)

  return {
    due: check.run,
    ran: false,
    reason: check.reason,
    clock,
    applyTime: config.applyTime,
    fingerprint: check.fingerprint,
    targetUrl: check.targetUrl,
    dayKey,
    domains,
  }
}

async function runApply(env: Env, at = new Date()): Promise<ApplyRunSummary> {
  const token = await requireToken(env)
  const config = await readConfig(env)
  const summary = await applyScheduledRedirects(token, config, at)
  await env.CONFIG.put(LAST_RUN_KEY, JSON.stringify(summary))
  return summary
}

async function maybeAutoApply(env: Env): Promise<{
  ran: boolean
  reason: string
  clock: ReturnType<typeof formatPhilippineClock>
  applyTime: string
  summary?: ApplyRunSummary
}> {
  const due = await checkDue(env)
  if (!due.due) {
    return {
      ran: false,
      reason: due.reason,
      clock: due.clock,
      applyTime: due.applyTime,
    }
  }

  await env.CONFIG.put(LAST_AUTO_KEY, due.fingerprint)

  try {
    const summary = await runApply(env)
    return {
      ran: true,
      reason: due.reason,
      clock: due.clock,
      applyTime: due.applyTime,
      summary,
    }
  } catch (error) {
    const current = await env.CONFIG.get(LAST_AUTO_KEY)
    if (current === due.fingerprint) {
      await env.CONFIG.delete(LAST_AUTO_KEY)
    }
    throw error
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (path === '/' || path === '/api/health') {
        const config = await readConfig(env)
        const clock = formatPhilippineClock(new Date(), config.timezone)
        return json({
          ok: true,
          service: 'bulk301-scheduler',
          timezone: config.timezone,
          applyTime: config.applyTime,
          clock,
          hasToken: Boolean(env.CLOUDFLARE_API_TOKEN),
          hasAdminSecret: Boolean(env.ADMIN_SECRET),
        })
      }

      if (path === '/api/clock' && request.method === 'GET') {
        const config = await readConfig(env)
        const clock = formatPhilippineClock(new Date(), config.timezone)
        const lastAuto = await env.CONFIG.get(LAST_AUTO_KEY)
        const check = shouldRunScheduledApply(config, lastAuto)
        return json({
          clock,
          applyTime: config.applyTime,
          due: check.run,
          reason: check.reason,
          lastAuto,
          fingerprint: check.fingerprint,
        })
      }

      if (path === '/api/config' && request.method === 'GET') {
        if (!isAuthorized(request, env)) return unauthorized()
        const config = await readConfig(env)
        const { dayKey, day } = getTargetForDate(config)
        const lastRunRaw = await env.CONFIG.get(LAST_RUN_KEY)
        const lastRun = lastRunRaw
          ? (JSON.parse(lastRunRaw) as ApplyRunSummary)
          : null
        const clock = formatPhilippineClock(new Date(), config.timezone)
        return json({
          config,
          today: { dayKey, targetUrl: day.targetUrl },
          lastRun,
          clock,
        })
      }

      if (path === '/api/config' && request.method === 'PUT') {
        if (!isAuthorized(request, env)) return unauthorized()
        const current = await readConfig(env)
        const body = (await request.json()) as Partial<AppConfig>
        const next = normalizeConfigInput(
          body,
          current,
          env.TIMEZONE || 'Asia/Manila',
        )
        await writeConfig(env, next)
        // Saving targets/time must NEVER start a 301 run. Marker stays so
        // catch-up cannot fire; schedule only runs at exact applyTime.
        return json({ ok: true, config: next })
      }

      if (path === '/api/reset-auto' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        // Soft reset for debugging only — does not apply redirects.
        await env.CONFIG.delete(LAST_AUTO_KEY)
        await env.CONFIG.delete('last_auto_date')
        const due = await checkDue(env)
        return json({ ok: true, reset: true, ...due })
      }

      if (path === '/api/claim-auto' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        const body = (await request.json().catch(() => ({}))) as {
          fingerprint?: string
        }
        const due = await checkDue(env)
        const fingerprint = body.fingerprint || due.fingerprint
        await env.CONFIG.put(LAST_AUTO_KEY, fingerprint)
        return json({
          ok: true,
          claimed: true,
          fingerprint,
          targetUrl: due.targetUrl,
          dayKey: due.dayKey,
          domains: due.domains,
          applyTime: due.applyTime,
          reason: due.reason,
          clock: due.clock,
        })
      }

      if (path === '/api/apply-one' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        const body = (await request.json()) as { domain?: string }
        if (!body.domain?.trim()) {
          return json({ error: 'domain is required' }, 400)
        }
        const token = await requireToken(env)
        const config = await readConfig(env)
        const result = await applyOneDomain(token, config, body.domain)
        return json({ ok: true, result })
      }

      // Apply every saved domain concurrently (same-time batches on the Worker).
      if (path === '/api/apply-all' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        const body = (await request.json().catch(() => ({}))) as {
          claimFingerprint?: string
        }
        if (body.claimFingerprint) {
          await env.CONFIG.put(LAST_AUTO_KEY, body.claimFingerprint)
        }
        try {
          const summary = await runApply(env)
          return json({ ok: true, summary, parallel: true })
        } catch (error) {
          if (body.claimFingerprint) {
            const current = await env.CONFIG.get(LAST_AUTO_KEY)
            if (current === body.claimFingerprint) {
              await env.CONFIG.delete(LAST_AUTO_KEY)
            }
          }
          throw error
        }
      }

      if (path === '/api/apply-finish' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        const body = (await request.json()) as {
          results?: DomainResult[]
          claimFingerprint?: string
        }
        const config = await readConfig(env)
        const results = Array.isArray(body.results) ? body.results : []
        const summary = summarizeResults(config, results)
        await env.CONFIG.put(LAST_RUN_KEY, JSON.stringify(summary))
        if (body.claimFingerprint) {
          await env.CONFIG.put(LAST_AUTO_KEY, body.claimFingerprint)
        }
        return json({ ok: true, summary })
      }

      if (path === '/api/apply' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        const summary = await runApply(env)
        return json({ ok: true, summary })
      }

      // UI uses checkOnly so the browser can show live per-domain progress.
      // Cron (scheduled) still uses full maybeAutoApply.
      if (path === '/api/tick' && request.method === 'POST') {
        if (!isAuthorized(request, env)) return unauthorized()
        const body = (await request.json().catch(() => ({}))) as {
          checkOnly?: boolean
        }
        if (body.checkOnly !== false) {
          const due = await checkDue(env)
          return json({ ok: true, ...due })
        }
        const result = await maybeAutoApply(env)
        return json({ ok: true, ...result })
      }

      if (path === '/api/last-run' && request.method === 'GET') {
        if (!isAuthorized(request, env)) return unauthorized()
        const lastRunRaw = await env.CONFIG.get(LAST_RUN_KEY)
        return json({
          lastRun: lastRunRaw
            ? (JSON.parse(lastRunRaw) as ApplyRunSummary)
            : null,
        })
      }

      return json({ error: 'Not found' }, 404)
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      )
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await maybeAutoApply(env)
          if (!result.ran) {
            console.log(`Cron skip: ${result.reason}`)
            return
          }
          console.log(
            `Cron apply done: ${result.summary?.dayKey} → ${result.summary?.targetUrl} ` +
              `at ${result.applyTime} ${result.clock.timeZone} ` +
              `(ok=${result.summary?.success} fail=${result.summary?.failed})`,
          )
        } catch (error) {
          console.error('Cron apply failed:', error)
        }
      })(),
    )
  },
}
