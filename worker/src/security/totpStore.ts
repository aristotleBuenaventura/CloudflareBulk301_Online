const TOTP_KEY = 'totp_config'

export interface TotpConfig {
  enabled: boolean
  secret: string | null
  pendingSecret: string | null
}

export async function readTotpConfig(kv: KVNamespace): Promise<TotpConfig> {
  const raw = await kv.get(TOTP_KEY)
  if (!raw) return { enabled: false, secret: null, pendingSecret: null }
  try {
    const parsed = JSON.parse(raw) as TotpConfig
    return {
      enabled: Boolean(parsed.enabled && parsed.secret),
      secret: parsed.secret || null,
      pendingSecret: parsed.pendingSecret || null,
    }
  } catch {
    return { enabled: false, secret: null, pendingSecret: null }
  }
}

export async function writeTotpConfig(
  kv: KVNamespace,
  config: TotpConfig,
): Promise<void> {
  await kv.put(TOTP_KEY, JSON.stringify(config))
}
