import type { Env } from './env'
import {
  APPLY_CONCURRENCY,
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
import { appendAudit, describeConfigChanges, readAudit } from './security/audit'
import { sendTelegramApplyUpdate, viewerTokenOk } from './security/telegram'
import { buildPublicViewerPayload } from './security/viewer'
import { clientIp, timingSafeEqual } from './security/crypto'
import {
  assertTrustedOrigin,
  cookieOptions,
  corsHeadersFor,
  isPublicInternet,
  parseAllowedOrigins,
  securityHeaders,
} from './security/headers'
import {
  assertBootstrapRateLimit,
  assertForgotPasswordRateLimit,
  assertLoginRateLimit,
  assertNotLocked,
  assertViewerRateLimit,
  clearFailedLogins,
  isIpAllowed,
  parseIpAllowlist,
  recordFailedLogin,
} from './security/rateLimit'
import { sendPasswordResetEmail } from './security/email'
import {
  buildResetUrl,
  cooldownRemainingMs,
  createPasswordResetToken,
  consumePasswordResetToken,
  markResetCooldown,
  resetCooldownSeconds,
} from './security/passwordReset'
import {
  buildSessionCookie,
  clearSessionCookie,
  consumeChallenge,
  createChallenge,
  createSession,
  IDLE_TIMEOUT_MS,
  listOnlinePresence,
  loadSession,
  parseCookieValue,
  readCookie,
  revokeSession,
  revokeSessionsForEmail,
  SESSION_TTL_MS,
  signCookieValue,
  touchSession,
  type SessionRecord,
} from './security/session'
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from './security/totp'
import {
  assertStrongAdminSecret,
  assertStrongPassword,
  bumpSessionVersion,
  countUsers,
  createUser,
  deleteUser,
  ensureUserIndexed,
  getUser,
  isValidEmail,
  listUsers,
  normalizeEmail,
  normalizeRole,
  putUser,
  setUserPassword,
  toPublicUser,
  upsertUserPassword,
  verifyPassword,
  type UserRole,
} from './security/users'
import {
  allConfigDomains,
  defaultConfig,
  normalizeApplyTime,
  uniqueDomains,
  type AppConfig,
  type ApplyRunSummary,
  type DaySchedule,
  type DomainResult,
} from './types'

export type { Env }

const LOCKOUT_HINT_MIN = 15

const CONFIG_KEY = 'app_config'
const LAST_RUN_KEY = 'last_run'
const LAST_AUTO_KEY = 'last_auto_fingerprint'

type AuthOk = { ok: true; session: SessionRecord }
type AuthFail = { ok: false; response: Response }

function signingSecret(env: Env): string {
  return env.ADMIN_SECRET
}

function bindSessionIp(env: Env): boolean {
  const v = String(env.BIND_SESSION_IP || '').toLowerCase()
  if (v === '0' || v === 'false') return false
  if (v === '1' || v === 'true') return true
  return isPublicInternet(env)
}

function withHeaders(
  request: Request,
  env: Env,
  init: ResponseInit & { headers?: HeadersInit } = {},
): ResponseInit {
  const publicInternet = isPublicInternet(env)
  const cors = corsHeadersFor(
    request,
    parseAllowedOrigins(env.ALLOWED_ORIGINS),
    publicInternet,
  )
  const base = { ...securityHeaders(request, publicInternet), ...cors }
  const extra =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init.headers as Record<string, string> | undefined) || {}
  return { ...init, headers: { ...base, ...extra } }
}

function json(
  request: Request,
  env: Env,
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data, null, 2), withHeaders(request, env, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  }))
}

function unauthorized(request: Request, env: Env, message?: string): Response {
  return json(
    request,
    env,
    { error: message || 'Unauthorized. Sign in required.' },
    401,
  )
}

function rejectOrigin(request: Request, env: Env): Response | null {
  const check = assertTrustedOrigin(request, env)
  if (check.ok) return null
  return json(request, env, { error: check.error }, check.status)
}

async function requireSession(
  request: Request,
  env: Env,
): Promise<AuthOk | AuthFail> {
  const allowlist = parseIpAllowlist(env.IP_ALLOWLIST)
  if (!isIpAllowed(request, allowlist)) {
    await appendAudit(env.CONFIG, request, 'login_ip_blocked', 'session check')
    return {
      ok: false,
      response: json(request, env, { error: 'IP not allowed.' }, 403),
    }
  }

  const raw = readCookie(request)
  if (!raw) {
    return { ok: false, response: unauthorized(request, env) }
  }
  const sessionId = await parseCookieValue(raw, signingSecret(env))
  if (!sessionId) {
    return { ok: false, response: unauthorized(request, env) }
  }
  const session = await loadSession(env.CONFIG, sessionId)
  if (!session) {
    return { ok: false, response: unauthorized(request, env) }
  }
  const user = await getUser(env.CONFIG, session.email)
  const userVersion = user?.passwordVersion ?? 0
  const sessionVersion = session.passwordVersion ?? 0
  if (!user || sessionVersion !== userVersion) {
    await revokeSession(env.CONFIG, session.id)
    await appendAudit(
      env.CONFIG,
      request,
      'logout',
      'password changed / session revoked',
    )
    return {
      ok: false,
      response: unauthorized(
        request,
        env,
        'Session expired after a password change. Sign in again.',
      ),
    }
  }
  if (bindSessionIp(env) && session.ip && session.ip !== 'unknown') {
    const ip = clientIp(request)
    if (ip !== 'unknown' && ip !== session.ip) {
      await revokeSession(env.CONFIG, session.id)
      await appendAudit(env.CONFIG, request, 'logout', 'session ip mismatch')
      return {
        ok: false,
        response: unauthorized(
          request,
          env,
          'Session invalidated due to network change. Sign in again.',
        ),
      }
    }
  }
  if (Date.now() - session.lastSeenAt > IDLE_TIMEOUT_MS) {
    await revokeSession(env.CONFIG, session.id)
    await appendAudit(env.CONFIG, request, 'session_idle_expired', session.id)
    return {
      ok: false,
      response: unauthorized(
        request,
        env,
        'Session expired due to inactivity. Sign in again.',
      ),
    }
  }
  await touchSession(env.CONFIG, session)
  return { ok: true, session }
}

/** Operator app access — session + completed 2FA + admin role. Superadmin is user-mgmt only. */
async function requireAppAccess(
  request: Request,
  env: Env,
): Promise<AuthUserOk | AuthFail> {
  const auth = await requireSession(request, env)
  if (!auth.ok) return auth
  const user = await getUser(env.CONFIG, auth.session.email)
  if (!user?.totpEnabled) {
    return {
      ok: false,
      response: json(
        request,
        env,
        {
          error: '2FA setup required before using Bulk301.',
          requires2faSetup: true,
        },
        403,
      ),
    }
  }
  const role = normalizeRole(user.role)
  if (role === 'superadmin') {
    return {
      ok: false,
      response: json(
        request,
        env,
        {
          error:
            'Superadmin accounts are limited to user management and cannot use Bulk301.',
        },
        403,
      ),
    }
  }
  if (role !== 'admin') {
    return {
      ok: false,
      response: json(
        request,
        env,
        {
          error:
            'Admin role required. Only admin accounts can use Bulk301 settings.',
        },
        403,
      ),
    }
  }
  return {
    ok: true,
    session: auth.session,
    role: 'admin',
    email: user.email,
  }
}

/**
 * Mutating schedule / settings / domains — admin + 2FA only.
 */
async function requireAdminEditor(
  request: Request,
  env: Env,
): Promise<AuthUserOk | AuthFail> {
  return requireAppAccess(request, env)
}


type AuthUserOk = { ok: true; session: SessionRecord; role: UserRole; email: string }

async function requireSuperadmin(
  request: Request,
  env: Env,
): Promise<AuthUserOk | AuthFail> {
  const auth = await requireSession(request, env)
  if (!auth.ok) return auth
  const user = await getUser(env.CONFIG, auth.session.email)
  if (!user?.totpEnabled) {
    return {
      ok: false,
      response: json(
        request,
        env,
        {
          error: '2FA setup required before using the admin dashboard.',
          requires2faSetup: true,
        },
        403,
      ),
    }
  }
  if (normalizeRole(user.role) !== 'superadmin') {
    return {
      ok: false,
      response: json(request, env, { error: 'Superadmin access required.' }, 403),
    }
  }
  return {
    ok: true,
    session: auth.session,
    role: 'superadmin',
    email: user.email,
  }
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
      domains: uniqueDomains(parsed.domains ?? base.domains),
      domains2: uniqueDomains(parsed.domains2 ?? base.domains2),
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
    ? uniqueDomains(body.domains.map((d) => String(d)))
    : current.domains
  const domains2 = Array.isArray(body.domains2)
    ? uniqueDomains(body.domains2.map((d) => String(d)))
    : current.domains2

  return {
    schedule,
    domains,
    domains2,
    wildcard:
      typeof body.wildcard === 'boolean' ? body.wildcard : current.wildcard,
    timezone: body.timezone?.trim() || current.timezone || fallbackTz,
    applyTime: normalizeApplyTime(
      body.applyTime !== undefined ? body.applyTime : current.applyTime,
    ),
    updatedAt: new Date().toISOString(),
  }
}

async function requireToken(env: Env, which: 1 | 2 = 1): Promise<string> {
  const raw =
    which === 2
      ? String(env.CLOUDFLARE_API_TOKEN_2 || '')
      : String(env.CLOUDFLARE_API_TOKEN || '')
  const token = normalizeApiToken(raw)
  const label = which === 2 ? 'CLOUDFLARE_API_TOKEN_2' : 'CLOUDFLARE_API_TOKEN'
  if (!token || isPlaceholderApiToken(token)) {
    throw new Error(
      `${label} is missing or still a placeholder in worker/.dev.vars. ` +
        'Paste a real Cloudflare API Token, save the file, restart wrangler dev, then try again.',
    )
  }
  return token
}

/** Primary token for domains; secondary for domains2 (null → those domains fail clearly). */
async function resolveApplyTokens(
  env: Env,
  config: AppConfig,
): Promise<{ primary: string; secondary: string | null }> {
  const has1 = uniqueDomains(config.domains).length > 0
  const has2 = uniqueDomains(config.domains2).length > 0

  // Account 1 token required when that list has domains, or when both lists empty
  // (keeps legacy apply paths consistent).
  const primary =
    has1 || !has2 ? await requireToken(env, 1) : 'unused'

  let secondary: string | null = null
  if (has2) {
    const raw = normalizeApiToken(String(env.CLOUDFLARE_API_TOKEN_2 || ''))
    secondary = raw && !isPlaceholderApiToken(raw) ? raw : null
  }

  return { primary, secondary }
}

async function checkDue(env: Env) {
  const config = await readConfig(env)
  const clock = formatPhilippineClock(new Date(), config.timezone)
  const lastAuto = await env.CONFIG.get(LAST_AUTO_KEY)
  const check = shouldRunScheduledApply(config, lastAuto)
  const domains = allConfigDomains(config)
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
  const config = await readConfig(env)
  const tokens = await resolveApplyTokens(env, config)
  const summary = await applyScheduledRedirects(tokens, config, at)
  await env.CONFIG.put(LAST_RUN_KEY, JSON.stringify(summary))
  return summary
}

async function notifyScheduledTelegram(
  env: Env,
  summary: ApplyRunSummary,
  applyTime?: string,
): Promise<void> {
  try {
    await sendTelegramApplyUpdate(env, summary, applyTime)
  } catch (err) {
    console.error('Telegram notify failed:', err)
  }
}

async function maybeAutoApply(env: Env) {
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
    // Await so cron waitUntil covers the Telegram request.
    await notifyScheduledTelegram(env, summary, due.applyTime)
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

async function issueSessionResponse(
  request: Request,
  env: Env,
  email: string,
  totpEnabled: boolean,
  message?: string,
): Promise<Response> {
  const user = await getUser(env.CONFIG, email)
  const session = await createSession(
    env.CONFIG,
    request,
    email,
    user?.passwordVersion ?? 0,
  )
  const value = await signCookieValue(session.id, signingSecret(env))
  const cookieOpts = cookieOptions(request, env.COOKIE_SAMESITE, isPublicInternet(env))
  return json(
    request,
    env,
    {
      ok: true,
      authenticated: true,
      email,
      totpEnabled,
      requires2faSetup: !totpEnabled,
      message,
    },
    200,
    {
      'Set-Cookie': buildSessionCookie(value, {
        ...cookieOpts,
        maxAgeSec: Math.ceil(SESSION_TTL_MS / 1000),
      }),
    },
  )
}

function adminSecretOk(env: Env, provided: string): boolean {
  return Boolean(env.ADMIN_SECRET) && timingSafeEqual(provided, env.ADMIN_SECRET)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(
        null,
        withHeaders(request, env, { status: 204 }),
      )
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0)
    if (contentLength > 512_000) {
      return json(request, env, { error: 'Request body too large.' }, 413)
    }

    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      const originBlock = rejectOrigin(request, env)
      if (
        originBlock &&
        path !== '/' &&
        path !== '/api/health' &&
        path !== '/api/public/viewer'
      ) {
        return originBlock
      }

      if (path === '/' || path === '/api/health') {
        return json(request, env, {
          ok: true,
          service: 'bulk301-scheduler',
          auth: 'cookie-session',
        })
      }

      // Public read-only viewer (token required — no session, no writes).
      if (path === '/api/public/viewer') {
        if (request.method !== 'GET') {
          return json(
            request,
            env,
            {
              error:
                'Method not allowed. Viewer is read-only (GET only).',
            },
            405,
            { Allow: 'GET' },
          )
        }
        const rate = await assertViewerRateLimit(env.CONFIG, request)
        if (!rate.ok) {
          return json(
            request,
            env,
            {
              error: `Too many requests. Try again in ${rate.retryAfterSec}s.`,
            },
            429,
          )
        }
        const provided =
          url.searchParams.get('t') ||
          url.searchParams.get('token') ||
          request.headers.get('X-Viewer-Token') ||
          ''
        if (!viewerTokenOk(env, provided)) {
          return json(
            request,
            env,
            { error: 'Invalid or missing viewer token.' },
            401,
          )
        }
        // Viewer token ≠ session: never grant config write / user / KV dump access.
        // Payload is a sanitized status snapshot only (no domains lists, no schedule table).
        const config = await readConfig(env)
        const { dayKey, day } = getTargetForDate(config)
        const lastRunRaw = await env.CONFIG.get(LAST_RUN_KEY)
        let lastRun: ApplyRunSummary | null = null
        if (lastRunRaw) {
          try {
            lastRun = JSON.parse(lastRunRaw) as ApplyRunSummary
          } catch {
            lastRun = null
          }
        }
        const payload = buildPublicViewerPayload(config, lastRun, {
          dayKey,
          dayLabel: day.label,
          targetUrl: day.targetUrl,
        })
        return json(request, env, payload, 200, {
          'X-Viewer-Mode': 'read-only',
          'X-Robots-Tag': 'noindex, nofollow',
        })
      }

      // ——— Auth ———
      // Public self-registration disabled. Use upsert-user (bootstrap / admin).
      if (path === '/api/auth/register' && request.method === 'POST') {
        return json(
          request,
          env,
          { error: 'Public registration is disabled. Ask an admin to create your account.' },
          403,
        )
      }

      // First user: ADMIN_SECRET only (optionally IP allowlisted).
      // Later users: authenticated 2FA session + ADMIN_SECRET.
      if (path === '/api/auth/upsert-user' && request.method === 'POST') {
        const allowlist = parseIpAllowlist(env.IP_ALLOWLIST)
        const publicInternet = isPublicInternet(env)
        if (allowlist.length > 0 && !isIpAllowed(request, allowlist)) {
          await appendAudit(env.CONFIG, request, 'login_ip_blocked', 'upsert-user')
          return json(request, env, { error: 'IP not allowed.' }, 403)
        }

        const rate = await assertBootstrapRateLimit(env.CONFIG, request)
        if (!rate.ok) {
          return json(
            request,
            env,
            { error: `Too many admin attempts. Try again in ${rate.retryAfterSec}s.` },
            429,
          )
        }

        const body = (await request.json().catch(() => ({}))) as {
          email?: string
          password?: string
          adminSecret?: string
          role?: string
        }
        const adminSecret = String(body.adminSecret || '')
        if (!adminSecretOk(env, adminSecret)) {
          await appendAudit(env.CONFIG, request, 'login_failed', 'upsert bad admin secret')
          return json(request, env, { error: 'Invalid admin secret.' }, 401)
        }
        if (publicInternet) {
          try {
            assertStrongAdminSecret(env.ADMIN_SECRET)
          } catch (error) {
            return json(
              request,
              env,
              { error: error instanceof Error ? error.message : String(error) },
              503,
            )
          }
        }

        const users = await countUsers(env.CONFIG)
        if (users > 0) {
          const auth = await requireSuperadmin(request, env)
          if (!auth.ok) {
            return json(
              request,
              env,
              {
                error:
                  'Creating or updating users requires a superadmin session (2FA) plus ADMIN_SECRET.',
              },
              401,
            )
          }
        } else if (publicInternet) {
          if (allowlist.length === 0) {
            return json(
              request,
              env,
              {
                error:
                  'Set IP_ALLOWLIST before creating the first user on a public Worker.',
              },
              503,
            )
          }
          if (!isIpAllowed(request, allowlist)) {
            return json(request, env, { error: 'IP not allowed for bootstrap.' }, 403)
          }
        }

        try {
          const requestedRole = body.role
            ? normalizeRole(body.role)
            : users === 0
              ? 'superadmin'
              : undefined
          // First account defaults to superadmin; later upserts keep/set role explicitly.
          const role: UserRole | undefined =
            requestedRole === 'superadmin' || requestedRole === 'admin'
              ? requestedRole
              : undefined
          if (users > 0 && role === 'superadmin') {
            return json(
              request,
              env,
              { error: 'Cannot promote to superadmin via upsert after bootstrap.' },
              400,
            )
          }
          const user = await upsertUserPassword(
            env.CONFIG,
            String(body.email || ''),
            String(body.password || ''),
            role,
          )
          await appendAudit(
            env.CONFIG,
            request,
            'login_success',
            `upsert-user ${user.email} role=${user.role}`,
          )
          return json(request, env, {
            ok: true,
            email: user.email,
            role: user.role,
            totpEnabled: user.totpEnabled,
            requires2faSetup: !user.totpEnabled,
          })
        } catch (error) {
          return json(
            request,
            env,
            { error: error instanceof Error ? error.message : String(error) },
            400,
          )
        }
      }

      if (path === '/api/auth/login' && request.method === 'POST') {
        const allowlist = parseIpAllowlist(env.IP_ALLOWLIST)
        if (!isIpAllowed(request, allowlist)) {
          await appendAudit(env.CONFIG, request, 'login_ip_blocked')
          return json(request, env, { error: 'IP not allowed.' }, 403)
        }

        const rate = await assertLoginRateLimit(env.CONFIG, request)
        if (!rate.ok) {
          await appendAudit(env.CONFIG, request, 'login_rate_limited')
          return json(
            request,
            env,
            {
              error: `Too many login attempts. Try again in ${rate.retryAfterSec}s.`,
            },
            429,
          )
        }

        const lock = await assertNotLocked(env.CONFIG)
        if (!lock.ok) {
          await appendAudit(env.CONFIG, request, 'login_locked')
          return json(
            request,
            env,
            {
              error: `Account locked after failed attempts. Try again in ${lock.retryAfterSec}s.`,
            },
            423,
          )
        }

        const body = (await request.json().catch(() => ({}))) as {
          email?: string
          password?: string
        }
        const email = normalizeEmail(String(body.email || ''))
        const password = String(body.password || '')

        if (!isValidEmail(email) || !password) {
          return json(
            request,
            env,
            { error: 'Email and password are required.' },
            400,
          )
        }

        const user = await getUser(env.CONFIG, email)
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
          const state = await recordFailedLogin(env.CONFIG)
          await appendAudit(
            env.CONFIG,
            request,
            'login_failed',
            `email=${email} failed=${state.failed}`,
            { actor: email },
          )
          if (state.lockedUntil) {
            return json(
              request,
              env,
              {
                error: `Too many failed logins. Locked for ${LOCKOUT_HINT_MIN} minutes.`,
              },
              423,
            )
          }
          return json(request, env, { error: 'Invalid credentials.' }, 401)
        }

        await clearFailedLogins(env.CONFIG)
        await ensureUserIndexed(env.CONFIG, user.email)

        if (user.totpEnabled && user.totpSecret) {
          const challenge = await createChallenge(env.CONFIG, request, user.email)
          await appendAudit(env.CONFIG, request, '2fa_required', user.email, {
            actor: user.email,
          })
          return json(request, env, {
            ok: true,
            requires2fa: true,
            challengeToken: challenge.id,
            email: user.email,
          })
        }

        // New account: session allowed only to finish mandatory 2FA setup.
        await appendAudit(
          env.CONFIG,
          request,
          'login_success',
          `${user.email} needs 2FA setup`,
          { actor: user.email },
        )
        return issueSessionResponse(request, env, user.email, false)
      }

      if (path === '/api/auth/2fa/verify' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          challengeToken?: string
          code?: string
        }
        const challenge = await consumeChallenge(
          env.CONFIG,
          String(body.challengeToken || ''),
        )
        if (!challenge) {
          return json(
            request,
            env,
            { error: '2FA challenge expired. Sign in again.' },
            401,
          )
        }
        const user = await getUser(env.CONFIG, challenge.email)
        if (!user?.totpEnabled || !user.totpSecret) {
          return json(request, env, { error: '2FA is not enabled.' }, 400)
        }
        const ok = await verifyTotpCode(user.totpSecret, String(body.code || ''))
        if (!ok) {
          await appendAudit(env.CONFIG, request, '2fa_failed', challenge.email, {
            actor: challenge.email,
          })
          await recordFailedLogin(env.CONFIG)
          return json(request, env, { error: 'Invalid authenticator code.' }, 401)
        }
        await clearFailedLogins(env.CONFIG)
        await appendAudit(env.CONFIG, request, '2fa_success', user.email, {
          actor: user.email,
        })
        await appendAudit(
          env.CONFIG,
          request,
          'login_success',
          `${user.email} via 2FA`,
          { actor: user.email },
        )
        return issueSessionResponse(request, env, user.email, true)
      }

      if (path === '/api/auth/logout' && request.method === 'POST') {
        const raw = readCookie(request)
        let logoutEmail: string | undefined
        if (raw) {
          const sessionId = await parseCookieValue(raw, signingSecret(env))
          if (sessionId) {
            const session = await loadSession(env.CONFIG, sessionId)
            logoutEmail = session?.email
            await revokeSession(env.CONFIG, sessionId)
          }
        }
        await appendAudit(env.CONFIG, request, 'logout', logoutEmail, {
          actor: logoutEmail,
        })
        const cookieOpts = cookieOptions(request, env.COOKIE_SAMESITE, isPublicInternet(env))
        return json(
          request,
          env,
          { ok: true },
          200,
          { 'Set-Cookie': clearSessionCookie(cookieOpts) },
        )
      }

      if (path === '/api/auth/forgot-password' && request.method === 'POST') {
        const sentMessage =
          'If an account exists for that email, a password reset link has been sent.'
        const waitMessage =
          'Please wait before requesting another reset link. Check your inbox (and spam) for the previous email.'

        const rate = await assertForgotPasswordRateLimit(env.CONFIG, request)
        if (!rate.ok) {
          return json(
            request,
            env,
            {
              error: `Too many password reset requests. Try again in ${rate.retryAfterSec}s.`,
              retryAfterSeconds: rate.retryAfterSec,
            },
            429,
          )
        }

        const body = (await request.json().catch(() => ({}))) as {
          email?: string
        }
        const email = normalizeEmail(String(body.email || ''))
        if (!email || !isValidEmail(email)) {
          return json(request, env, { error: 'Email is required.' }, 400)
        }

        const cooldownSec = resetCooldownSeconds()
        const remainingMs = await cooldownRemainingMs(env.CONFIG, email)
        if (remainingMs > 0) {
          const retryAfterSeconds = Math.ceil(remainingMs / 1000)
          await appendAudit(
            env.CONFIG,
            request,
            'password_reset_requested',
            `cooldown_${retryAfterSeconds}s ${email}`,
          )
          return json(
            request,
            env,
            { error: waitMessage, retryAfterSeconds },
            429,
          )
        }

        const user = await getUser(env.CONFIG, email)
        if (!user) {
          await markResetCooldown(env.CONFIG, email)
          await appendAudit(
            env.CONFIG,
            request,
            'password_reset_requested',
            `unknown_email ${email}`,
          )
          return json(request, env, {
            ok: true,
            message: sentMessage,
            retryAfterSeconds: cooldownSec,
          })
        }

        const { token } = await createPasswordResetToken(env.CONFIG, user.email)
        const resetUrl = buildResetUrl(env, token)
        const delivery = await sendPasswordResetEmail(env, {
          to: user.email,
          resetUrl,
        })
        await markResetCooldown(env.CONFIG, user.email)
        await appendAudit(
          env.CONFIG,
          request,
          'password_reset_requested',
          `${user.email} ${delivery.sent ? 'email_sent' : 'email_logged'}`,
        )
        return json(request, env, {
          ok: true,
          message: sentMessage,
          retryAfterSeconds: cooldownSec,
        })
      }

      if (path === '/api/auth/reset-password' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          token?: string
          password?: string
        }
        const token = String(body.token || '').trim()
        const password = String(body.password || '')
        if (!token) {
          return json(request, env, { error: 'Reset token is required.' }, 400)
        }
        try {
          // Validate strength before consuming the one-time token.
          assertStrongPassword(password)
          const email = await consumePasswordResetToken(env.CONFIG, token)
          if (!email) {
            await appendAudit(
              env.CONFIG,
              request,
              'password_reset_failed',
              'invalid_or_expired_token',
            )
            return json(
              request,
              env,
              {
                error:
                  'This reset link is invalid or has expired. Request a new one.',
              },
              400,
            )
          }
          await setUserPassword(env.CONFIG, email, password)
          await appendAudit(
            env.CONFIG,
            request,
            'password_reset_success',
            email,
          )
          return json(request, env, {
            ok: true,
            message: 'Password updated. You can sign in with your new password.',
          })
        } catch (error) {
          return json(
            request,
            env,
            { error: error instanceof Error ? error.message : String(error) },
            400,
          )
        }
      }

      if (path === '/api/auth/me' && request.method === 'GET') {
        const auth = await requireSession(request, env)
        if (!auth.ok) return auth.response
        const user = await getUser(env.CONFIG, auth.session.email)
        const totpEnabled = Boolean(user?.totpEnabled)
        return json(request, env, {
          ok: true,
          authenticated: true,
          email: auth.session.email,
          role: user ? normalizeRole(user.role) : 'admin',
          totpEnabled,
          requires2faSetup: !totpEnabled,
          session: {
            createdAt: new Date(auth.session.createdAt).toISOString(),
            lastSeenAt: new Date(auth.session.lastSeenAt).toISOString(),
          },
        })
      }

      if (path === '/api/auth/heartbeat' && request.method === 'POST') {
        const auth = await requireSession(request, env)
        if (!auth.ok) return auth.response
        return json(request, env, {
          ok: true,
          email: auth.session.email,
          lastSeenAt: new Date(auth.session.lastSeenAt).toISOString(),
        })
      }

      if (path === '/api/auth/2fa/setup/start' && request.method === 'POST') {
        const auth = await requireSession(request, env)
        if (!auth.ok) return auth.response
        const user = await getUser(env.CONFIG, auth.session.email)
        if (!user) {
          return json(request, env, { error: 'User not found.' }, 404)
        }
        if (user.totpEnabled) {
          return json(request, env, { error: '2FA is already enabled.' }, 400)
        }
        const secret = generateTotpSecret()
        await putUser(env.CONFIG, {
          ...user,
          pendingTotpSecret: secret,
          updatedAt: new Date().toISOString(),
        })
        await appendAudit(env.CONFIG, request, '2fa_setup_started', user.email)
        return json(request, env, {
          ok: true,
          secret,
          otpauthUrl: buildOtpauthUrl({ secret, label: user.email }),
        })
      }

      if (path === '/api/auth/2fa/setup/confirm' && request.method === 'POST') {
        const auth = await requireSession(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          code?: string
        }
        const user = await getUser(env.CONFIG, auth.session.email)
        if (!user?.pendingTotpSecret) {
          return json(
            request,
            env,
            { error: 'No pending 2FA setup. Start setup again.' },
            400,
          )
        }
        const ok = await verifyTotpCode(
          user.pendingTotpSecret,
          String(body.code || ''),
        )
        if (!ok) {
          return json(request, env, { error: 'Invalid authenticator code.' }, 400)
        }
        await putUser(env.CONFIG, {
          ...user,
          totpEnabled: true,
          totpSecret: user.pendingTotpSecret,
          pendingTotpSecret: null,
          updatedAt: new Date().toISOString(),
        })
        await appendAudit(env.CONFIG, request, '2fa_enabled', user.email)
        return json(request, env, {
          ok: true,
          totpEnabled: true,
          requires2faSetup: false,
        })
      }

      // 2FA cannot be fully turned off for accounts (mandatory). Recovery reset requires ADMIN_SECRET.
      if (path === '/api/auth/2fa/reset' && request.method === 'POST') {
        const auth = await requireSession(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          adminSecret?: string
          code?: string
        }
        if (!adminSecretOk(env, String(body.adminSecret || ''))) {
          return json(request, env, { error: 'Invalid admin secret.' }, 401)
        }
        const user = await getUser(env.CONFIG, auth.session.email)
        if (!user) {
          return json(request, env, { error: 'User not found.' }, 404)
        }
        if (user.totpEnabled && user.totpSecret) {
          const ok = await verifyTotpCode(user.totpSecret, String(body.code || ''))
          if (!ok) {
            return json(
              request,
              env,
              { error: 'Invalid authenticator code.' },
              401,
            )
          }
        }
        await putUser(env.CONFIG, {
          ...user,
          totpEnabled: false,
          totpSecret: null,
          pendingTotpSecret: null,
          updatedAt: new Date().toISOString(),
        })
        await appendAudit(env.CONFIG, request, '2fa_disabled', user.email)
        return json(request, env, {
          ok: true,
          totpEnabled: false,
          requires2faSetup: true,
        })
      }


      // ——— Superadmin user management ———
      if (path === '/api/admin/users' && request.method === 'GET') {
        const auth = await requireSuperadmin(request, env)
        if (!auth.ok) return auth.response
        const [users, presence] = await Promise.all([
          listUsers(env.CONFIG),
          listOnlinePresence(env.CONFIG),
        ])
        const onlineByEmail = new Map(
          presence.map((p) => [p.email.trim().toLowerCase(), p]),
        )
        const enriched = users.map((user) => {
          const online = onlineByEmail.get(user.email.trim().toLowerCase())
          return {
            ...user,
            online: Boolean(online),
            lastSeenAt: online
              ? new Date(online.lastSeenAt).toISOString()
              : null,
            lastSeenIp: online?.ip || null,
          }
        })
        return json(request, env, {
          ok: true,
          users: enriched,
          onlineCount: presence.length,
        })
      }

      if (path === '/api/admin/users' && request.method === 'POST') {
        // Superadmin-only: create operator (admin) accounts from the dashboard.
        const auth = await requireSuperadmin(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          email?: string
          password?: string
          role?: string
        }
        // Ignore any client-supplied role — dashboard can only create admin users.
        if (normalizeRole(body.role || 'admin') === 'superadmin') {
          return json(
            request,
            env,
            { error: 'Cannot create another superadmin from the dashboard.' },
            400,
          )
        }
        try {
          const user = await createUser(
            env.CONFIG,
            String(body.email || ''),
            String(body.password || ''),
            'admin',
          )
          await appendAudit(
            env.CONFIG,
            request,
            'login_success',
            `admin-created ${user.email} by ${auth.email}`,
          )
          return json(request, env, { ok: true, user: toPublicUser(user) })
        } catch (error) {
          return json(
            request,
            env,
            { error: error instanceof Error ? error.message : String(error) },
            400,
          )
        }
      }

      {
        const passMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/password$/)
        if (passMatch && request.method === 'POST') {
          const auth = await requireSuperadmin(request, env)
          if (!auth.ok) return auth.response
          const targetEmail = normalizeEmail(decodeURIComponent(passMatch[1]!))
          const target = await getUser(env.CONFIG, targetEmail)
          if (!target) {
            return json(request, env, { error: 'User not found.' }, 404)
          }
          if (
            target.role === 'superadmin' &&
            target.email !== auth.email
          ) {
            return json(
              request,
              env,
              { error: 'Cannot change another superadmin password.' },
              403,
            )
          }
          const body = (await request.json().catch(() => ({}))) as {
            password?: string
          }
          try {
            const user = await setUserPassword(
              env.CONFIG,
              targetEmail,
              String(body.password || ''),
            )
            await revokeSessionsForEmail(env.CONFIG, targetEmail)
            await appendAudit(
              env.CONFIG,
              request,
              'config_saved',
              `password-reset ${user.email} by ${auth.email}`,
              { actor: auth.email },
            )
            return json(request, env, { ok: true, user: toPublicUser(user) })
          } catch (error) {
            return json(
              request,
              env,
              { error: error instanceof Error ? error.message : String(error) },
              400,
            )
          }
        }
      }

      {
        const logoutMatch = path.match(
          /^\/api\/admin\/users\/([^/]+)\/logout$/,
        )
        if (logoutMatch && request.method === 'POST') {
          const auth = await requireSuperadmin(request, env)
          if (!auth.ok) return auth.response
          const targetEmail = normalizeEmail(
            decodeURIComponent(logoutMatch[1]!),
          )
          if (targetEmail === auth.email) {
            return json(
              request,
              env,
              { error: 'Use Sign out for your own session.' },
              400,
            )
          }
          const target = await getUser(env.CONFIG, targetEmail)
          if (!target) {
            return json(request, env, { error: 'User not found.' }, 404)
          }
          if (normalizeRole(target.role) === 'superadmin') {
            return json(
              request,
              env,
              { error: 'Cannot force-logout another superadmin.' },
              403,
            )
          }
          await bumpSessionVersion(env.CONFIG, targetEmail)
          const revoked = await revokeSessionsForEmail(env.CONFIG, targetEmail)
          await appendAudit(
            env.CONFIG,
            request,
            'session_force_logout',
            `force-logout ${targetEmail} sessions=${revoked} by ${auth.email}`,
            { actor: auth.email },
          )
          return json(request, env, {
            ok: true,
            email: targetEmail,
            revoked,
          })
        }
      }

      {
        const delMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/)
        if (delMatch && request.method === 'DELETE') {
          const auth = await requireSuperadmin(request, env)
          if (!auth.ok) return auth.response
          const targetEmail = normalizeEmail(decodeURIComponent(delMatch[1]!))
          if (targetEmail === auth.email) {
            return json(request, env, { error: 'Cannot delete your own account.' }, 400)
          }
          try {
            await revokeSessionsForEmail(env.CONFIG, targetEmail)
            await deleteUser(env.CONFIG, targetEmail)
            await appendAudit(
              env.CONFIG,
              request,
              'logout',
              `deleted-user ${targetEmail} by ${auth.email}`,
              { actor: auth.email },
            )
            return json(request, env, { ok: true })
          } catch (error) {
            return json(
              request,
              env,
              { error: error instanceof Error ? error.message : String(error) },
              400,
            )
          }
        }
      }

      if (path === '/api/audit' && request.method === 'GET') {
        const auth = await requireSuperadmin(request, env)
        if (!auth.ok) return auth.response
        const events = await readAudit(env.CONFIG, 200)
        return json(request, env, { ok: true, events })
      }

      if (path === '/api/clock' && request.method === 'GET') {
        // Not public — schedule timing must not be scrapable without login.
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const config = await readConfig(env)
        const clock = formatPhilippineClock(new Date(), config.timezone)
        const lastAuto = await env.CONFIG.get(LAST_AUTO_KEY)
        const check = shouldRunScheduledApply(config, lastAuto)
        return json(request, env, {
          clock,
          applyTime: config.applyTime,
          due: check.run,
          reason: check.reason,
          lastAuto,
          fingerprint: check.fingerprint,
        })
      }

      if (path === '/api/config' && request.method === 'GET') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const config = await readConfig(env)
        const { dayKey, day } = getTargetForDate(config)
        const lastRunRaw = await env.CONFIG.get(LAST_RUN_KEY)
        const lastRun = lastRunRaw
          ? (JSON.parse(lastRunRaw) as ApplyRunSummary)
          : null
        const clock = formatPhilippineClock(new Date(), config.timezone)
        const user = await getUser(env.CONFIG, auth.session.email)
        return json(request, env, {
          config,
          today: { dayKey, targetUrl: day.targetUrl },
          lastRun,
          clock,
          email: auth.email,
          role: auth.role,
          canEdit: auth.role === 'admin',
          totpEnabled: Boolean(user?.totpEnabled),
        })
      }

      if (path === '/api/config' && request.method === 'PUT') {
        const auth = await requireAdminEditor(request, env)
        if (!auth.ok) return auth.response
        const current = await readConfig(env)
        const body = (await request.json()) as Partial<AppConfig>
        const next = normalizeConfigInput(
          body,
          current,
          env.TIMEZONE || 'Asia/Manila',
        )
        await writeConfig(env, next)
        const changes = describeConfigChanges(current, next)
        if (changes.length > 0) {
          await appendAudit(
            env.CONFIG,
            request,
            'config_saved',
            changes.join(' · '),
            { actor: auth.email, changes },
          )
        }
        return json(request, env, { ok: true, config: next })
      }

      if (path === '/api/reset-auto' && request.method === 'POST') {
        const auth = await requireAdminEditor(request, env)
        if (!auth.ok) return auth.response
        await env.CONFIG.delete(LAST_AUTO_KEY)
        await env.CONFIG.delete('last_auto_date')
        const due = await checkDue(env)
        return json(request, env, { ok: true, reset: true, ...due })
      }

      if (path === '/api/claim-auto' && request.method === 'POST') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          fingerprint?: string
        }
        const due = await checkDue(env)
        const fingerprint = body.fingerprint || due.fingerprint
        await env.CONFIG.put(LAST_AUTO_KEY, fingerprint)
        return json(request, env, {
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
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json()) as { domain?: string }
        if (!body.domain?.trim()) {
          return json(request, env, { error: 'domain is required' }, 400)
        }
        const token = await requireToken(env)
        const config = await readConfig(env)
        const result = await applyOneDomain(token, config, body.domain)
        return json(request, env, { ok: true, result })
      }

      if (path === '/api/apply-all' && request.method === 'POST') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          claimFingerprint?: string
        }
        if (body.claimFingerprint) {
          await env.CONFIG.put(LAST_AUTO_KEY, body.claimFingerprint)
        }
        try {
          const summary = await runApply(env)
          if (body.claimFingerprint) {
            await notifyScheduledTelegram(
              env,
              summary,
              (await readConfig(env)).applyTime,
            )
          }
          await appendAudit(
            env.CONFIG,
            request,
            'apply_run',
            `${summary.dayKey} → ${summary.targetUrl} ok=${summary.success} fail=${summary.failed}`,
            { actor: auth.session.email },
          )
          return json(request, env, { ok: true, summary, parallel: true })
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

      if (path === '/api/apply-stream' && request.method === 'POST') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          claimFingerprint?: string
        }
        const actorEmail = auth.session.email

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (payload: unknown) => {
              controller.enqueue(
                encoder.encode(`${JSON.stringify(payload)}\n`),
              )
            }

            try {
              if (body.claimFingerprint) {
                await env.CONFIG.put(LAST_AUTO_KEY, body.claimFingerprint)
              }

              const config = await readConfig(env)
              const tokens = await resolveApplyTokens(env, config)
              const domains1 = uniqueDomains(config.domains)
              const domains2 = uniqueDomains(config.domains2)
              const totalDomains = domains1.length + domains2.length
              const { dayKey, day } = getTargetForDate(config)
              const targetUrl = day.targetUrl.trim()

              send({
                type: 'start',
                total: totalDomains,
                concurrency: APPLY_CONCURRENCY,
                targetUrl,
                dayKey,
              })

              if (!targetUrl) {
                const summary = summarizeResults(config, [
                  {
                    domain: '(schedule)',
                    status: 'failed',
                    message: `No target URL set for ${day.label}.`,
                  },
                ])
                await env.CONFIG.put(LAST_RUN_KEY, JSON.stringify(summary))
                send({ type: 'done', summary })
                return
              }

              if (totalDomains === 0) {
                const summary = summarizeResults(config, [])
                await env.CONFIG.put(LAST_RUN_KEY, JSON.stringify(summary))
                send({ type: 'done', summary })
                return
              }

              const summary = await applyScheduledRedirects(
                tokens,
                config,
                new Date(),
                (result, index, completed) => {
                  send({
                    type: 'result',
                    index,
                    completed,
                    total: totalDomains,
                    concurrency: APPLY_CONCURRENCY,
                    result,
                  })
                },
              )

              await env.CONFIG.put(LAST_RUN_KEY, JSON.stringify(summary))
              if (body.claimFingerprint) {
                await env.CONFIG.put(LAST_AUTO_KEY, body.claimFingerprint)
              }
              await appendAudit(
                env.CONFIG,
                request,
                'apply_run',
                `${summary.dayKey} → ${summary.targetUrl} ok=${summary.success} fail=${summary.failed}`,
                { actor: actorEmail },
              )
              // UI schedule tick claims with fingerprint — same as cron scheduled run.
              if (body.claimFingerprint) {
                await notifyScheduledTelegram(env, summary, config.applyTime)
              }
              send({ type: 'done', summary })
            } catch (error) {
              if (body.claimFingerprint) {
                const current = await env.CONFIG.get(LAST_AUTO_KEY)
                if (current === body.claimFingerprint) {
                  await env.CONFIG.delete(LAST_AUTO_KEY)
                }
              }
              send({
                type: 'error',
                error: error instanceof Error ? error.message : String(error),
              })
            } finally {
              controller.close()
            }
          },
        })

        return new Response(
          stream,
          withHeaders(request, env, {
            status: 200,
            headers: {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          }),
        )
      }

      if (path === '/api/apply-finish' && request.method === 'POST') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
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
        await appendAudit(
          env.CONFIG,
          request,
          'apply_run',
          `${summary.dayKey} → ${summary.targetUrl}`,
          { actor: auth.session.email },
        )
        if (body.claimFingerprint) {
          await notifyScheduledTelegram(env, summary, config.applyTime)
        }
        return json(request, env, { ok: true, summary })
      }

      if (path === '/api/apply' && request.method === 'POST') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const summary = await runApply(env)
        await appendAudit(
          env.CONFIG,
          request,
          'apply_run',
          `${summary.dayKey} → ${summary.targetUrl}`,
          { actor: auth.session.email },
        )
        return json(request, env, { ok: true, summary })
      }

      if (path === '/api/tick' && request.method === 'POST') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const body = (await request.json().catch(() => ({}))) as {
          checkOnly?: boolean
        }
        if (body.checkOnly !== false) {
          const due = await checkDue(env)
          return json(request, env, { ok: true, ...due })
        }
        const result = await maybeAutoApply(env)
        return json(request, env, { ok: true, ...result })
      }

      if (path === '/api/last-run' && request.method === 'GET') {
        const auth = await requireAppAccess(request, env)
        if (!auth.ok) return auth.response
        const lastRunRaw = await env.CONFIG.get(LAST_RUN_KEY)
        return json(request, env, {
          lastRun: lastRunRaw
            ? (JSON.parse(lastRunRaw) as ApplyRunSummary)
            : null,
        })
      }

      return json(request, env, { error: 'Not found' }, 404)
    } catch (error) {
      return json(
        request,
        env,
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

