import type { Env } from '../env'
import type { ApplyRunSummary } from '../types'
import { timingSafeEqual } from './crypto'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function dayLabel(dayKey: string): string {
  const labels: Record<string, string> = {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  }
  return labels[dayKey] || dayKey
}

function viewerUrl(env: Env): string | null {
  const app = String(env.APP_URL || '').replace(/\/+$/, '')
  const token = String(env.VIEWER_TOKEN || '').trim()
  if (!app || !token) return null
  return `${app}/viewer?t=${encodeURIComponent(token)}`
}

/** Telegram URL buttons require a public http(s) URL — localhost is rejected. */
function publicViewerButtonUrl(url: string | null): string | null {
  if (!url) return null
  if (!/^https:\/\//i.test(url)) return null
  try {
    const host = new URL(url).hostname
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.local')
    ) {
      return null
    }
  } catch {
    return null
  }
  return url
}

export function formatApplyTelegramHtml(
  summary: ApplyRunSummary,
  opts?: { applyTime?: string; viewUrlNote?: string | null },
): string {
  const failed = (summary.results || [])
    .filter((r) => r.status === 'failed')
    .slice(0, 8)
  const statusIcon = summary.failed === 0 ? '✅' : '⚠️'
  const timeZone = summary.timezone || 'Asia/Manila'
  const ranLocal = new Date(summary.ranAt).toLocaleString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
  const lines = [
    `<b>Bulk301 · Scheduled apply ${statusIcon}</b>`,
    '',
    `Day: <b>${escapeHtml(dayLabel(summary.dayKey))}</b>`,
    `Target: <code>${escapeHtml(summary.targetUrl || '—')}</code>`,
    `Time: ${escapeHtml(ranLocal)} ${escapeHtml(timeZone)}`,
    '',
    `Domains: ${(summary.success || 0) + (summary.skipped || 0) + (summary.failed || 0)}`,
    `✅ Success: ${summary.success || 0}`,
    `⏭ Skipped: ${summary.skipped || 0}`,
    `❌ Failed: ${summary.failed || 0}`,
  ]

  if (failed.length > 0) {
    lines.push('', 'Failed:')
    for (const row of failed) {
      const msg = (row.message || '').slice(0, 120)
      lines.push(
        `• <code>${escapeHtml(row.domain)}</code>${
          msg ? ` — ${escapeHtml(msg)}` : ''
        }`,
      )
    }
    if (summary.failed > failed.length) {
      lines.push(`• …and ${summary.failed - failed.length} more`)
    }
  }

  if (opts?.viewUrlNote) {
    lines.push('', `Viewer: ${escapeHtml(opts.viewUrlNote)}`)
  }

  return lines.join('\n')
}

export async function sendTelegramApplyUpdate(
  env: Env,
  summary: ApplyRunSummary,
  applyTime?: string,
): Promise<void> {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '').trim()
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim()
  if (!botToken || !chatId) {
    console.warn('Telegram skip: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
    return
  }

  const viewUrl = viewerUrl(env)
  const buttonUrl = publicViewerButtonUrl(viewUrl)
  const text = formatApplyTelegramHtml(summary, {
    applyTime,
    // Local / non-HTTPS: include URL in body so message still sends.
    viewUrlNote: buttonUrl ? null : viewUrl,
  })

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }

  if (buttonUrl) {
    payload.reply_markup = {
      inline_keyboard: [
        [{ text: 'Click online results here!', url: buttonUrl }],
      ],
    }
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(
      `Telegram send failed: HTTP ${response.status} ${body.slice(0, 300)}`,
    )
    // Retry without button if markup was the problem.
    if (payload.reply_markup) {
      delete payload.reply_markup
      const retry = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            text: formatApplyTelegramHtml(summary, {
              applyTime,
              viewUrlNote: viewUrl,
            }),
          }),
        },
      )
      if (!retry.ok) {
        const retryBody = await retry.text().catch(() => '')
        console.error(
          `Telegram retry failed: HTTP ${retry.status} ${retryBody.slice(0, 300)}`,
        )
      } else {
        console.log('Telegram sent (retry without button)')
      }
    }
    return
  }

  console.log('Telegram apply update sent')
}

export function viewerTokenOk(env: Env, provided: string): boolean {
  const expected = String(env.VIEWER_TOKEN || '').trim()
  const got = String(provided || '').trim()
  if (!expected || expected.length < 24 || !got) return false
  return timingSafeEqual(expected, got)
}
