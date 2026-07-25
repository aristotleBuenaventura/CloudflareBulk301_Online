import type { DayKey, DaySchedule } from '../types'
import { DAY_KEYS_BY_JS } from '../types'

export function dayKeyFromDate(date: Date): DayKey {
  return DAY_KEYS_BY_JS[date.getDay()]
}

export function getTargetForDate(
  schedule: DaySchedule[],
  date: Date,
): DaySchedule {
  const key = dayKeyFromDate(date)
  return schedule.find((d) => d.key === key) ?? schedule[0]
}

export function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
