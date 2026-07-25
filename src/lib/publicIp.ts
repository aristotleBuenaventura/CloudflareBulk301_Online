export async function fetchPublicIps(): Promise<{
  ipv4: string | null
  ipv6: string | null
}> {
  const [ipv4, ipv6] = await Promise.all([
    fetchText('https://api4.ipify.org').catch(() => null),
    fetchText('https://api6.ipify.org').catch(() => null),
  ])
  return { ipv4, ipv6 }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed: ${url}`)
  return (await response.text()).trim()
}
