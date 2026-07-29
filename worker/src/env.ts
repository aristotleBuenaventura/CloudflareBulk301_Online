/** Shared Worker env typing (imported by security helpers). */
export interface Env {
  CONFIG: KVNamespace
  CLOUDFLARE_API_TOKEN: string
  /** Optional second account token (domains2). */
  CLOUDFLARE_API_TOKEN_2?: string
  ADMIN_SECRET: string
  TIMEZONE: string
  ALLOWED_ORIGINS?: string
  IP_ALLOWLIST?: string
  COOKIE_SAMESITE?: string
  /** Set true when UI is on the public internet */
  PUBLIC_INTERNET?: string
  /** When true with PUBLIC_INTERNET, bind sessions to client IP */
  BIND_SESSION_IP?: string
  /** Public UI origin for password-reset links (e.g. http://localhost:5173) */
  APP_URL?: string
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_USER?: string
  SMTP_PASS?: string
  SMTP_FROM?: string
  /** Unguessable token for public read-only viewer page */
  VIEWER_TOKEN?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
}
