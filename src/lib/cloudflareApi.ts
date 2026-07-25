import type {
  CloudflareUser,
  CloudflareZone,
  RedirectCreateResult,
} from '../types'

const BASE = '/cf'

export class CloudflareApiException extends Error {
  statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'CloudflareApiException'
    this.statusCode = statusCode
  }
}

interface ApiResponse {
  success: boolean
  result: unknown
  errors: Array<{ code?: number; message?: string }>
}

export class CloudflareApi {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  private get headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }
  }

  async verifyToken(): Promise<CloudflareUser> {
    if (this.token.startsWith('cfat_')) {
      return this.verifyAccountToken()
    }
    return this.verifyUserToken()
  }

  private async verifyUserToken(): Promise<CloudflareUser> {
    const response = await fetch(`${BASE}/user/tokens/verify`, {
      headers: this.headers,
    })
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.formatAuthError(body, response.status),
        response.status,
      )
    }

    const userResponse = await fetch(`${BASE}/user`, { headers: this.headers })
    const userBody = await this.decode(userResponse)
    if (userBody.success) {
      const user = userBody.result as { email?: string; id?: string } | null
      return {
        email: user?.email ?? 'Cloudflare account',
        id: user?.id ?? '',
        isAccountToken: false,
      }
    }

    return { email: 'Cloudflare user token', id: '', isAccountToken: false }
  }

  private async verifyAccountToken(): Promise<CloudflareUser> {
    const response = await fetch(`${BASE}/accounts`, { headers: this.headers })
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.formatAuthError(body, response.status),
        response.status,
      )
    }

    const accounts = (body.result as Array<{ id?: string; name?: string }>) ?? []
    if (accounts.length === 0) {
      throw new CloudflareApiException(
        'No Cloudflare accounts found for this token.',
        response.status,
      )
    }

    const account = accounts[0]
    if (!account.id) {
      throw new CloudflareApiException('Could not read Cloudflare account ID.')
    }

    return {
      email: account.name ?? 'Cloudflare account',
      id: account.id,
      isAccountToken: true,
    }
  }

  async findZone(domain: string): Promise<CloudflareZone | null> {
    for (const candidate of this.domainCandidates(domain)) {
      const zones = await this.fetchZonesByName(candidate)
      for (const zone of zones) {
        if (zone.name === candidate) return zone
      }
    }
    return null
  }

  private async fetchZonesByName(name: string): Promise<CloudflareZone[]> {
    const response = await fetch(
      `${BASE}/zones?name=${encodeURIComponent(name)}&match=all`,
      { headers: this.headers },
    )
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.firstError(body) ?? 'Failed to look up zone.',
        response.status,
      )
    }

    const zones = (body.result as Array<{ id: string; name: string; status?: string }>) ?? []
    return zones.map((zone) => ({
      id: zone.id,
      name: zone.name.toLowerCase(),
      status: zone.status ?? 'unknown',
    }))
  }

  async createFullDomainRedirect(opts: {
    zoneId: string
    sourceDomain: string
    targetBaseUrl: string
    wildcard: boolean
  }): Promise<RedirectCreateResult> {
    const target = this.normalizeTargetUrl(opts.targetBaseUrl)

    if (this.token.startsWith('cfat_')) {
      await this.removeAllPageRulesForDomain(opts.zoneId, opts.sourceDomain)
      return this.createDynamicRedirectRule({
        zoneId: opts.zoneId,
        sourceDomain: opts.sourceDomain,
        target,
        wildcard: opts.wildcard,
      })
    }

    try {
      try {
        await this.removeBulk301RedirectRules(opts.zoneId)
      } catch {
        // Ignore — may not have Redirect Rules on this zone.
      }
      return await this.createPageRule({
        zoneId: opts.zoneId,
        sourceDomain: opts.sourceDomain,
        target,
        wildcard: opts.wildcard,
      })
    } catch (error) {
      if (
        error instanceof CloudflareApiException &&
        this.isPageRulesUnsupportedMessage(error.message)
      ) {
        await this.removeAllPageRulesForDomain(opts.zoneId, opts.sourceDomain)
        return this.createDynamicRedirectRule({
          zoneId: opts.zoneId,
          sourceDomain: opts.sourceDomain,
          target,
          wildcard: opts.wildcard,
        })
      }
      throw error
    }
  }

  private async createPageRule(opts: {
    zoneId: string
    sourceDomain: string
    target: string
    wildcard: boolean
  }): Promise<RedirectCreateResult> {
    const domain = this.normalizeDomain(opts.sourceDomain)
    const pattern = this.pageRulePattern(domain, opts.wildcard)
    const forwardUrl = this.pageRuleForwardUrl(opts.target, opts.wildcard)
    const summary = this.redirectSummary(domain, opts.target, opts.wildcard)

    await this.removeAllPageRulesForDomain(opts.zoneId, domain)

    const existingRules = await this.listPageRules(opts.zoneId)
    const priority = this.nextPageRulePriority(existingRules)

    const response = await fetch(`${BASE}/zones/${opts.zoneId}/pagerules`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        targets: [
          {
            target: 'url',
            constraint: { operator: 'matches', value: pattern },
          },
        ],
        actions: [
          {
            id: 'forwarding_url',
            value: { url: forwardUrl, status_code: 301 },
          },
        ],
        priority,
        status: 'active',
      }),
    })

    const body = await this.decode(response)
    if (!body.success) {
      const message = this.firstError(body) ?? 'Failed to create Page Rule.'
      throw new CloudflareApiException(message, response.status)
    }

    const verified = await this.findActivePageRuleAfterCreate(
      opts.zoneId,
      pattern,
      forwardUrl,
    )
    if (!verified) {
      throw new CloudflareApiException(
        'Cloudflare did not save the Page Rule. Ensure your token has Zone → Page Rules → Edit permission.',
      )
    }

    return {
      created: true,
      message: `Page Rule created: ${summary}. Check Rules → Page Rules.`,
    }
  }

  private async createDynamicRedirectRule(opts: {
    zoneId: string
    sourceDomain: string
    target: string
    wildcard: boolean
  }): Promise<RedirectCreateResult> {
    const domain = this.normalizeDomain(opts.sourceDomain)
    const targetUrl = this.dynamicTargetUrl(opts.target, opts.wildcard)
    const expression = this.redirectExpression(domain, opts.wildcard)

    await this.removeAllPageRulesForDomain(opts.zoneId, domain)
    try {
      await this.removeBulk301RedirectRules(opts.zoneId)
    } catch (error) {
      if (
        !(error instanceof CloudflareApiException) ||
        !this.isPermissionStatusCode(error.statusCode, error.message)
      ) {
        throw error
      }
    }

    const rulePayload = {
      description: 'Bulk 301 redirect (Cloudflare Bulk301 app)',
      expression,
      action: 'redirect',
      action_parameters: {
        from_value: {
          status_code: 301,
          target_url: targetUrl,
          preserve_query_string: opts.wildcard,
        },
      },
      enabled: true,
    }

    const entrypoint = await this.getRedirectEntrypoint(opts.zoneId)
    if (entrypoint) {
      const rulesetId = entrypoint.id as string
      await this.addRuleToRuleset(opts.zoneId, rulesetId, {
        ref: `bulk301_${Math.abs(this.hashCode(domain))}`,
        ...rulePayload,
      })
    } else {
      await this.createRedirectRuleset(opts.zoneId, [
        {
          ref: `bulk301_${Math.abs(this.hashCode(domain))}`,
          ...rulePayload,
        },
      ])
    }

    const verifiedEntrypoint = await this.getRedirectEntrypoint(opts.zoneId)
    const verifiedRules =
      (verifiedEntrypoint?.rules as Array<Record<string, unknown>>) ?? []
    if (!this.hasMatchingDynamicRule(verifiedRules, opts.target, opts.wildcard)) {
      throw new CloudflareApiException(
        'Cloudflare did not save the Redirect Rule. Ensure your token has Zone → Single Redirect → Edit permission.',
        403,
      )
    }

    const matchingRule = verifiedRules.find((rule) =>
      this.isDuplicateDynamicRule(rule, opts.target, opts.wildcard),
    )
    const ruleId = matchingRule?.id as string | undefined

    return {
      created: true,
      message:
        `Redirect Rule saved${ruleId ? ` (ID: ${ruleId})` : ''}.\n` +
        `⚠️ NOT in Page Rules — open Rules → Overview → Redirect Rules in Cloudflare.`,
    }
  }

  private async removeAllPageRulesForDomain(
    zoneId: string,
    sourceDomain: string,
  ): Promise<void> {
    const domain = this.normalizeDomain(sourceDomain)
    const rules = await this.listPageRules(zoneId)
    const deleted = new Set<string>()

    for (const rule of rules) {
      if (rule.status !== 'active') continue

      const actions = (rule.actions as Array<{ id?: string }>) ?? []
      const hasForwarding = actions.some((a) => a.id === 'forwarding_url')
      if (!hasForwarding) continue

      const targets = (rule.targets as Array<{ constraint?: { value?: string } }>) ?? []
      const matchesDomain = targets.some((t) =>
        this.isPageRulePatternForDomain(t.constraint?.value, domain),
      )
      if (!matchesDomain) continue

      const ruleId = rule.id as string | undefined
      if (!ruleId || deleted.has(ruleId)) continue
      deleted.add(ruleId)
      await this.deletePageRule(zoneId, ruleId)
    }
  }

  private async removeBulk301RedirectRules(zoneId: string): Promise<void> {
    const entrypoint = await this.getRedirectEntrypoint(zoneId)
    if (!entrypoint) return

    const rulesetId = entrypoint.id as string
    const rules = (entrypoint.rules as Array<Record<string, unknown>>) ?? []

    for (const rule of rules) {
      if (!this.isBulk301RedirectRule(rule)) continue
      const ruleId = rule.id as string | undefined
      if (!ruleId) continue
      await this.deleteRedirectRule(zoneId, rulesetId, ruleId)
    }
  }

  private async deletePageRule(zoneId: string, ruleId: string): Promise<void> {
    const response = await fetch(
      `${BASE}/zones/${zoneId}/pagerules/${ruleId}`,
      { method: 'DELETE', headers: this.headers },
    )
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.firstError(body) ?? 'Failed to remove Page Rule.',
        response.status,
      )
    }
  }

  private async deleteRedirectRule(
    zoneId: string,
    rulesetId: string,
    ruleId: string,
  ): Promise<void> {
    const response = await fetch(
      `${BASE}/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`,
      { method: 'DELETE', headers: this.headers },
    )
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.firstError(body) ?? 'Failed to remove Redirect Rule.',
        response.status,
      )
    }
  }

  private async createRedirectRuleset(
    zoneId: string,
    rules: Array<Record<string, unknown>>,
  ): Promise<void> {
    const response = await fetch(`${BASE}/zones/${zoneId}/rulesets`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: 'Redirect rules ruleset',
        kind: 'zone',
        phase: 'http_request_dynamic_redirect',
        rules,
      }),
    })
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.formatRulesetError(body, response.status) ??
          'Failed to create redirect rule.',
        response.status,
      )
    }
  }

  private async addRuleToRuleset(
    zoneId: string,
    rulesetId: string,
    rule: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(
      `${BASE}/zones/${zoneId}/rulesets/${rulesetId}/rules`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(rule),
      },
    )
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.formatRulesetError(body, response.status) ??
          'Failed to add redirect rule.',
        response.status,
      )
    }
  }

  private async getRedirectEntrypoint(
    zoneId: string,
  ): Promise<Record<string, unknown> | null> {
    const response = await fetch(
      `${BASE}/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
      { headers: this.headers },
    )

    if (response.status === 404) return null

    const body = await this.decode(response)
    if (!body.success) {
      const message = this.firstError(body)
      if (
        response.status === 404 ||
        (message?.toLowerCase().includes('not found') ?? false)
      ) {
        return null
      }
      if (this.isPermissionStatusCode(response.status, message)) {
        throw new CloudflareApiException(
          this.formatRulesetError(body, response.status) ??
            'Missing Redirect Rules permission.',
          response.status,
        )
      }
      return null
    }

    return body.result as Record<string, unknown> | null
  }

  private async listPageRules(
    zoneId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(`${BASE}/zones/${zoneId}/pagerules`, {
      headers: this.headers,
    })
    const body = await this.decode(response)
    if (!body.success) {
      throw new CloudflareApiException(
        this.firstError(body) ?? 'Failed to list Page Rules.',
        response.status,
      )
    }
    return (body.result as Array<Record<string, unknown>>) ?? []
  }

  private async findActivePageRuleAfterCreate(
    zoneId: string,
    pattern: string,
    forwardUrl: string,
  ): Promise<Record<string, unknown> | null> {
    const rules = await this.listPageRules(zoneId)
    return this.findActivePageRule(rules, pattern, forwardUrl)
  }

  private findActivePageRule(
    rules: Array<Record<string, unknown>>,
    pattern: string,
    forwardUrl: string,
  ): Record<string, unknown> | null {
    for (const rule of rules) {
      if (rule.status !== 'active') continue

      const targets = (rule.targets as Array<{ constraint?: { value?: string } }>) ?? []
      const actions =
        (rule.actions as Array<{
          id?: string
          value?: { url?: string; status_code?: number | string }
        }>) ?? []

      const matchesPattern = targets.some(
        (t) =>
          this.normalizePattern(t.constraint?.value) ===
          this.normalizePattern(pattern),
      )

      const matchesForward = actions.some((action) => {
        if (action.id !== 'forwarding_url') return false
        const url = this.normalizeForwardUrl(action.value?.url)
        const statusCode = action.value?.status_code
        return (
          url === this.normalizeForwardUrl(forwardUrl) &&
          (statusCode === 301 || statusCode === '301')
        )
      })

      if (matchesPattern && matchesForward) return rule
    }
    return null
  }

  private isPageRulePatternForDomain(
    pattern: string | undefined,
    domain: string,
  ): boolean {
    if (!pattern) return false
    const normalized = this.normalizePattern(pattern) ?? ''
    const d = domain.toLowerCase()
    const candidates = new Set([
      this.normalizePattern(`*${d}/*`),
      this.normalizePattern(`https://${d}/*`),
      this.normalizePattern(`${d}/*`),
      this.normalizePattern(`http://${d}/*`),
      this.normalizePattern(`*${d}*`),
    ])
    return candidates.has(normalized)
  }

  private isBulk301RedirectRule(rule: Record<string, unknown>): boolean {
    if (rule.action !== 'redirect') return false
    const description = (rule.description as string) ?? ''
    return (
      description.includes('Cloudflare Bulk301 app') ||
      description.includes('Bulk 301 redirect')
    )
  }

  private hasMatchingDynamicRule(
    rules: Array<Record<string, unknown>>,
    target: string,
    wildcard: boolean,
  ): boolean {
    return rules.some((rule) =>
      this.isDuplicateDynamicRule(rule, target, wildcard),
    )
  }

  private isDuplicateDynamicRule(
    rule: Record<string, unknown>,
    target: string,
    wildcard: boolean,
  ): boolean {
    if (rule.action !== 'redirect') return false
    const params = rule.action_parameters as
      | { from_value?: { target_url?: { expression?: string; value?: string } } }
      | undefined
    const targetUrl = params?.from_value?.target_url
    if (!targetUrl) return false

    if (wildcard) {
      return (
        targetUrl.expression === `concat("${target}", http.request.uri.path)`
      )
    }
    return (
      this.normalizeForwardUrl(targetUrl.value) ===
      this.normalizeForwardUrl(target)
    )
  }

  private isPageRulesUnsupportedMessage(message?: string): boolean {
    if (!message) return false
    const lower = message.toLowerCase()
    return (
      lower.includes('account owned') ||
      lower.includes('account-owned') ||
      lower.includes('does not support account')
    )
  }

  private nextPageRulePriority(rules: Array<Record<string, unknown>>): number {
    if (rules.length === 0) return 1
    let highest = 0
    for (const rule of rules) {
      const priority = rule.priority
      if (typeof priority === 'number' && priority > highest) {
        highest = priority
      }
    }
    return highest + 1
  }

  private pageRulePattern(domain: string, wildcard: boolean): string {
    return wildcard ? `*${domain}/*` : `${domain}/*`
  }

  private redirectExpression(domain: string, wildcard: boolean): string {
    return wildcard ? 'true' : `(http.host eq "${domain}")`
  }

  private pageRuleForwardUrl(target: string, wildcard: boolean): string {
    return wildcard ? `${target}/$2` : target
  }

  private dynamicTargetUrl(
    target: string,
    wildcard: boolean,
  ): { expression: string } | { value: string } {
    if (wildcard) {
      return { expression: `concat("${target}", http.request.uri.path)` }
    }
    return { value: target }
  }

  private redirectSummary(
    domain: string,
    target: string,
    wildcard: boolean,
  ): string {
    return wildcard ? `*${domain}/* → ${target}/$2` : `${domain}/* → ${target}`
  }

  private async decode(response: Response): Promise<ApiResponse> {
    const decoded = (await response.json()) as Record<string, unknown>
    return {
      success: decoded.success === true,
      result: decoded.result,
      errors: (decoded.errors as ApiResponse['errors']) ?? [],
    }
  }

  private formatRulesetError(
    body: ApiResponse,
    statusCode: number,
  ): string | null {
    const message = this.firstError(body)
    if (this.isPermissionStatusCode(statusCode, message)) {
      return (
        'Missing Redirect Rules permission. ' +
        'Add Zone → Single Redirect → Edit to your API token.\n\n' +
        `Cloudflare: ${message ?? `HTTP ${statusCode}`}`
      )
    }
    return message
  }

  private isPermissionStatusCode(
    statusCode?: number,
    message?: string | null,
  ): boolean {
    if (statusCode === 401 || statusCode === 403) return true
    const lower = message?.toLowerCase() ?? ''
    return (
      lower.includes('authentication') ||
      lower.includes('unauthorized') ||
      lower.includes('permission') ||
      lower.includes('not allowed') ||
      lower.includes('forbidden') ||
      lower.includes('missing the permissions')
    )
  }

  private firstError(body: ApiResponse): string | null {
    if (body.errors.length === 0) return null
    return (body.errors[0].message as string) ?? null
  }

  private formatAuthError(body: ApiResponse, statusCode: number): string {
    const message = this.firstError(body)
    const code = body.errors[0]?.code

    if (
      code === 9109 ||
      (message?.toLowerCase().includes('location') ?? false)
    ) {
      const blockedIp = this.extractBlockedIp(message)
      if (blockedIp) {
        return (
          `Cloudflare blocked IP: ${blockedIp}\n\n` +
          'Add this exact IP to your token allowlist, or remove IP filtering.'
        )
      }
      return (
        'This token has IP restrictions. Add your current IP to the token ' +
        'allowlist, or remove the IP filter.'
      )
    }

    if (
      this.token.startsWith('cfat_') &&
      message?.toLowerCase().includes('invalid api token')
    ) {
      return 'Account API token could not be verified. Check that the token is active and has the required permissions.'
    }

    return message ?? `Authentication failed (HTTP ${statusCode}).`
  }

  private extractBlockedIp(message: string | null): string | null {
    if (!message) return null
    const match = /location:\s*(.+)$/.exec(message.trim())
    return match?.[1]?.trim() ?? null
  }

  private domainCandidates(domain: string): string[] {
    const normalized = this.normalizeDomain(domain)
    const candidates = new Set([normalized])
    if (normalized.startsWith('www.')) {
      candidates.add(normalized.substring(4))
    } else {
      candidates.add(`www.${normalized}`)
    }
    return Array.from(candidates)
  }

  private normalizeDomain(domain: string): string {
    let value = domain.trim().toLowerCase()
    value = value.replace(/^https?:\/\//, '')
    value = value.split('/')[0]
    return value
  }

  private normalizeTargetUrl(url: string): string {
    let value = url.trim()
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      value = `https://${value}`
    }
    const uri = new URL(value)
    let normalized = `${uri.protocol}//${uri.hostname}`
    if (uri.port && uri.port !== '80' && uri.port !== '443') {
      normalized = `${normalized}:${uri.port}`
    }
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  }

  private normalizePattern(pattern?: string | null): string | null {
    return pattern?.trim().toLowerCase() ?? null
  }

  private normalizeForwardUrl(url?: string | null): string | null {
    if (!url) return null
    let normalized = url.trim()
    if (normalized.endsWith('/') && !normalized.includes('$')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  }

  private hashCode(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i)
      hash |= 0
    }
    return hash
  }
}

export function pendingNote(zone: CloudflareZone): string {
  if (zone.status === 'pending' || zone.status === 'initializing') {
    return (
      'Rule saved. Redirect will work once nameservers point to Cloudflare ' +
      'and the zone status becomes Active.'
    )
  }
  return ''
}
