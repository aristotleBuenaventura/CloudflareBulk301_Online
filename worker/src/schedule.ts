import type { AppConfig, DayKey, DaySchedule } from './types'
import { normalizeApplyTime } from './types'

const WEEKDAY_TO_KEY: Record<string, DayKey> = {
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
  sunday: 'sunday',
}

export function dayKeyInTimezone(date: Date, timeZone: string): DayKey {
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone,
  })
    .format(date)
    .toLowerCase()

  return WEEKDAY_TO_KEY[weekday] ?? 'monday'
}

export function getTargetForDay(
  schedule: DaySchedule[],
  dayKey: DayKey,
): DaySchedule {
  return schedule.find((d) => d.key === dayKey) ?? schedule[0]
}

export function getTargetForDate(
  config: AppConfig,
  date = new Date(),
): { dayKey: DayKey; day: DaySchedule } {
  const dayKey = dayKeyInTimezone(date, config.timezone || 'Asia/Manila')
  return { dayKey, day: getTargetForDay(config.schedule, dayKey) }
}

/** Local calendar date YYYY-MM-DD in the given IANA timezone. */
export function dateKeyInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/** Local clock time HH:MM (24h) in the given IANA timezone. */
export function timeInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)

  let hour = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  // Some runtimes return "24" for midnight
  if (hour === '24') hour = '00'
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

function toMinutes(hhmm: string): number {
  const [h, m] = normalizeApplyTime(hhmm).split(':').map(Number)
  return h * 60 + m
}

/**
 * Cloudflare Cron can fire slightly after the scheduled minute. Allow a short
 * same-day grace window so apply still runs with the browser closed.
 * Still once per date|applyTime; no all-day catch-up (target edits later OK).
 */
export const SCHEDULE_GRACE_MINUTES = 2

/**
 * Fire at scheduled HH:MM (local timezone), once per date+applyTime.
 * Target URL is NOT part of the fingerprint.
 * Grace: applyTime .. applyTime+SCHEDULE_GRACE_MINUTES (same calendar day).
 */
export function shouldRunScheduledApply(
  config: AppConfig,
  lastAutoFingerprint: string | null,
  now = new Date(),
): {
  run: boolean
  dateKey: string
  fingerprint: string
  reason: string
  nowTime: string
  targetUrl: string
} {
  const timeZone = config.timezone || 'Asia/Manila'
  const dateKey = dateKeyInTimezone(now, timeZone)
  const currentTime = timeInTimezone(now, timeZone)
  const applyTime = normalizeApplyTime(config.applyTime)
  const { day } = getTargetForDate(config, now)
  const targetUrl = day.targetUrl.trim()
  // Slot id only — exclude target so edits don't look like a new schedule hit.
  const fingerprint = `${dateKey}|${applyTime}`
  // Accept legacy fingerprints that included targetUrl (`date|time|url`).
  const alreadyRan =
    lastAutoFingerprint === fingerprint ||
    Boolean(lastAutoFingerprint?.startsWith(`${fingerprint}|`))

  if (alreadyRan) {
    return {
      run: false,
      dateKey,
      fingerprint,
      nowTime: currentTime,
      targetUrl,
      reason: `Already ran today at ${applyTime} → ${targetUrl || '(empty)'}. Next run tomorrow at ${applyTime}.`,
    }
  }

  const nowMin = toMinutes(currentTime)
  const applyMin = toMinutes(applyTime)
  const inWindow =
    nowMin >= applyMin && nowMin <= applyMin + SCHEDULE_GRACE_MINUTES

  if (!inWindow) {
    const waiting = nowMin < applyMin
    return {
      run: false,
      dateKey,
      fingerprint,
      nowTime: currentTime,
      targetUrl,
      reason: waiting
        ? `Waiting for schedule ${applyTime} ${timeZone} (now ${currentTime})`
        : `Schedule ${applyTime} already passed today (now ${currentTime}). Saved targets apply at next ${applyTime}.`,
    }
  }

  return {
    run: true,
    dateKey,
    fingerprint,
    nowTime: currentTime,
    targetUrl,
    reason: `Schedule hit ${applyTime} → ${targetUrl || '(empty target)'}`,
  }
}

export function formatPhilippineClock(date = new Date(), timeZone = 'Asia/Manila'): {
  time: string
  date: string
  weekday: string
  timeZone: string
} {
  const time = timeInTimezone(date, timeZone)
  const dateStr = dateKeyInTimezone(date, timeZone)
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone,
  }).format(date)

  return { time, date: dateStr, weekday, timeZone }
}
