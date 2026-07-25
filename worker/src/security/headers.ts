export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Allow credentialed cross-origin UI → Worker when ALLOWED_ORIGINS is set
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // API responses — tight CSP (no HTML app served from Worker by default)
    'Content-Security-Policy':
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  }
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

export function corsHeadersFor(
  request: Request,
  allowedOrigins: string[],
): Record<string, string> {
  const origin = request.headers.get('Origin') || ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  }

  if (allowedOrigins.length === 0) {
    // Dev-friendly: reflect request origin when present (needed for credentials)
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin
    }
    return headers
  }

  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export function cookieOptions(request: Request, envSameSite?: string): {
  secure: boolean
  sameSite: 'Lax' | 'None' | 'Strict'
} {
  const url = new URL(request.url)
  const isHttps = url.protocol === 'https:'
  const raw = (envSameSite || '').toLowerCase()
  let sameSite: 'Lax' | 'None' | 'Strict' = 'Lax'
  if (raw === 'none' || raw === 'strict' || raw === 'lax') {
    sameSite = (raw.charAt(0).toUpperCase() + raw.slice(1)) as
      | 'Lax'
      | 'None'
      | 'Strict'
  } else if (isHttps && request.headers.get('Origin')) {
    // Cross-origin HTTPS UI → Worker
    const origin = request.headers.get('Origin') || ''
    if (origin && origin !== url.origin) sameSite = 'None'
  }
  const secure = isHttps || sameSite === 'None'
  return { secure, sameSite }
}
