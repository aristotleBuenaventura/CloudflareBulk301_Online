/** Daily apply time helpers — storage stays 24h "HH:MM"; UI uses 12h + AM/PM. */

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function parseApplyTime24(value: string): {
  hour12: number
  minute: number
  period: 'AM' | 'PM'
} {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value || '00:00').trim())
  const hour24 = match ? Number(match[1]) : 0
  const minute = match ? Number(match[2]) : 0
  const period: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return { hour12, minute, period }
}

export function toApplyTime24(
  hour12: number,
  minute: number,
  period: 'AM' | 'PM',
): string {
  const h12 = Math.min(12, Math.max(1, hour12))
  const m = Math.min(59, Math.max(0, minute))
  let hour24 = h12 % 12
  if (period === 'PM') hour24 += 12
  return `${pad2(hour24)}:${pad2(m)}`
}

/** e.g. "00:00" → "12:00 AM", "14:30" → "2:30 PM" */
export function formatApplyTime12(value: string): string {
  const { hour12, minute, period } = parseApplyTime24(value)
  return `${hour12}:${pad2(minute)} ${period}`
}
