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

export function formatApplyTelegramHtml(
  summary: ApplyRunSummary,
  opts?: { applyTime?: string; viewUrl?: string | null },
): string {
  const failed = (summary.results || [])
    .filter((r) => r.status === 'failed')
    .slice(0, 8)
  const statusIcon = summary.failed === 0 ? '✅' : '⚠️'
  const lines = [
    `<b>Bulk301 · Scheduled apply ${statusIcon}</b>`,
    '',
    `Day: <b>${escapeHtml(dayLabel(summary.dayKey))}</b>`,
    `Target: <code>${escapeHtml(summary.targetUrl || '—')}</code>`,
    `Time: ${escapeHtml(opts?.applyTime || '—')} ${escapeHtml(summary.timezone || '')}`,
    `Ran: ${escapeHtml(new Date(summary.ranAt).toLocaleString())}`,
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

  if (opts?.viewUrl) {
    lines.push('', 'View online:')
    // Telegram often strips <a href> for localhost/private URLs — always show plain URL.
    const safeUrl = escapeHtml(opts.viewUrl)
    if (/^https:\/\//i.test(opts.viewUrl)) {
      lines.push(`<a href="${safeUrl}">${safeUrl}</a>`)
    } else {
      lines.push(safeUrl)
    }
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
  if (!botToken || !chatId) return

  const text = formatApplyTelegramHtml(summary, {
    applyTime,
    viewUrl: viewerUrl(env),
  })

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(
      `Telegram send failed: HTTP ${response.status} ${body.slice(0, 200)}`,
    )
  }
}

export function viewerTokenOk(env: Env, provided: string): boolean {
  const expected = String(env.VIEWER_TOKEN || '').trim()
  const got = String(provided || '').trim()
  if (!expected || expected.length < 24 || !got) return false
  return timingSafeEqual(expected, got)
}
