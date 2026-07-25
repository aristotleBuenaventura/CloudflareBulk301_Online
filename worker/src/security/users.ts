import { randomId, timingSafeEqual } from './crypto'

export interface UserRecord {
  email: string
  passwordHash: string
  totpEnabled: boolean
  totpSecret: string | null
  pendingTotpSecret: string | null
  createdAt: string
  updatedAt: string
}

function userKey(email: string): string {
  return `user:${normalizeEmail(email)}`
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))
}

function bufferToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Stored format: pbkdf2$iterations$saltHex$hashHex */
export async function hashPassword(password: string): Promise<string> {
  const iterations = 100_000
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    key,
    256,
  )
  return `pbkdf2$${iterations}$${bufferToHex(salt)}$${bufferToHex(bits)}`
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  const salt = hexToBytes(parts[2]!)
  const expected = parts[3]!
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    key,
    256,
  )
  return timingSafeEqual(bufferToHex(bits), expected)
}

export async function getUser(
  kv: KVNamespace,
  email: string,
): Promise<UserRecord | null> {
  const raw = await kv.get(userKey(email))
  if (!raw) return null
  try {
    return JSON.parse(raw) as UserRecord
  } catch {
    return null
  }
}

export async function putUser(kv: KVNamespace, user: UserRecord): Promise<void> {
  await kv.put(userKey(user.email), JSON.stringify(user))
}

export async function createUser(
  kv: KVNamespace,
  email: string,
  password: string,
): Promise<UserRecord> {
  const normalized = normalizeEmail(email)
  if (!isValidEmail(normalized)) {
    throw new Error('Invalid email address.')
  }
  if (password.length < 10) {
    throw new Error('Password must be at least 10 characters.')
  }
  const existing = await getUser(kv, normalized)
  if (existing) {
    throw new Error('An account with this email already exists.')
  }
  const now = new Date().toISOString()
  const user: UserRecord = {
    email: normalized,
    passwordHash: await hashPassword(password),
    totpEnabled: false,
    totpSecret: null,
    pendingTotpSecret: null,
    createdAt: now,
    updatedAt: now,
  }
  await putUser(kv, user)
  return user
}

export async function upsertUserPassword(
  kv: KVNamespace,
  email: string,
  password: string,
): Promise<UserRecord> {
  const normalized = normalizeEmail(email)
  const existing = await getUser(kv, normalized)
  if (existing) {
    const next: UserRecord = {
      ...existing,
      passwordHash: await hashPassword(password),
      updatedAt: new Date().toISOString(),
    }
    await putUser(kv, next)
    return next
  }
  return createUser(kv, normalized, password)
}

export function newPendingId(): string {
  return randomId(8)
}
