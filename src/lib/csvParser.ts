export function parseDomains(content: string): string[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const domains = new Set<string>()
  let skippedHeader = false

  for (const line of lines) {
    const domain = firstColumn(line)
    if (!domain) continue

    if (!skippedHeader && looksLikeHeader(domain)) {
      skippedHeader = true
      continue
    }

    domains.add(domain)
  }

  return Array.from(domains)
}

function firstColumn(line: string): string {
  const commaIndex = line.indexOf(',')
  if (commaIndex === -1) return line.trim()
  return line.substring(0, commaIndex).trim()
}

function looksLikeHeader(value: string): boolean {
  const first = value.toLowerCase()
  return (
    first === 'domain' ||
    first === 'domains' ||
    first === 'hostname' ||
    first === 'site' ||
    first === 'zone'
  )
}
