/** Shared Worker env typing (imported by security helpers). */
export interface Env {
  CONFIG: KVNamespace
  CLOUDFLARE_API_TOKEN: string
  ADMIN_SECRET: string
  TIMEZONE: string
  ALLOWED_ORIGINS?: string
  IP_ALLOWLIST?: string
  COOKIE_SAMESITE?: string
  /** Set true when UI is on the public internet */
  PUBLIC_INTERNET?: string
  /** When true with PUBLIC_INTERNET, bind sessions to client IP */
  BIND_SESSION_IP?: string
}
