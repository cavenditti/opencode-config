import dns from "node:dns"

export type Verdict = {
  decision: "allow" | "ask" | "deny"
  risk: number
  categories: string[]
  reason: string
}

export type GateRule = { pattern: string; action: "allow" | "ask" | "deny" }

export type NormalizedUrl = {
  href: string
  scheme: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
}

export function normalizeUrl(raw: string): NormalizedUrl | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return {
    href: url.href,
    scheme: url.protocol.replace(/:$/, "").toLowerCase(),
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  }
}

function stripTrailingDots(host: string): string {
  let h = host
  while (h.endsWith(".")) h = h.slice(0, -1)
  return h
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "metadata.azure.com",
  "fd00:ec2::254",
])

export function isCloudMetadataHost(host: string): boolean {
  return CLOUD_METADATA_HOSTS.has(stripBrackets(stripTrailingDots(host.trim().toLowerCase())))
}

export function isPrivateIp(ip: string): boolean {
  let addr = stripBrackets(ip.trim().toLowerCase())
  const zoneIndex = addr.indexOf("%")
  if (zoneIndex !== -1) addr = addr.slice(0, zoneIndex)

  if (addr.startsWith("::ffff:")) {
    const mapped = addr.slice("::ffff:".length)
    if (mapped.includes(".")) return isPrivateIp(mapped)
    const hextets = mapped.split(":")
    if (hextets.length === 2) {
      const hi = parseInt(hextets[0], 16)
      const lo = parseInt(hextets[1], 16)
      if (!Number.isNaN(hi) && !Number.isNaN(lo) && hi <= 0xffff && lo <= 0xffff) {
        return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
      }
    }
    return false
  }

  if (addr.includes(":")) {
    if (addr === "::1" || addr === "::") return true
    const first = addr.split(":")[0]
    const head = parseInt(first === "" ? "0" : first, 16)
    if (Number.isNaN(head)) return false
    if ((head & 0xfe00) === 0xfc00) return true
    if ((head & 0xffc0) === 0xfe80) return true
    return false
  }

  const parts = addr.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((part) => parseInt(part, 10))
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const a = octets[0]
  const b = octets[1]
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function isPrivateHost(host: string): boolean {
  const h = stripTrailingDots(host.trim().toLowerCase())
  if (h === "localhost" || h.endsWith(".localhost")) return true
  const bare = stripBrackets(h)
  if (bare.includes(":")) return isPrivateIp(bare)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) return isPrivateIp(bare)
  return false
}

export async function resolveHostIps(host: string): Promise<string[]> {
  try {
    const results = await dns.promises.lookup(stripBrackets(host), { all: true, verbatim: true })
    return results.map((r) => r.address)
  } catch {
    return []
  }
}

const SECRET_QUERY_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "apikey",
  "privatekey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
])

function canonicalParamName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "")
}

export function redactUrl(nu: NormalizedUrl): string {
  const params = new URLSearchParams(nu.search)
  const parts: string[] = []
  for (const [name] of params) {
    const label = SECRET_QUERY_NAMES.has(canonicalParamName(name)) ? "[redacted-secret]" : "[redacted]"
    parts.push(`${encodeURIComponent(name)}=${label}`)
  }
  const search = parts.length > 0 ? `?${parts.join("&")}` : ""
  return `${nu.scheme}://${nu.host}${nu.pathname}${search}`
}

export function matchUrlPattern(href: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp("^" + escaped + "$", "s").test(href)
}

export function toGateRules(value: unknown): GateRule[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const rules: GateRule[] = []
  for (const [pattern, action] of Object.entries(value)) {
    if (action === "allow" || action === "ask" || action === "deny") {
      rules.push({ pattern, action })
    }
  }
  return rules
}

export function matchUrlRule(href: string, rules: GateRule[]): GateRule | undefined {
  let matched: GateRule | undefined
  for (const rule of rules) {
    if (rule.pattern === "*" && rule.action === "ask") continue
    if (matchUrlPattern(href, rule.pattern)) matched = rule
  }
  return matched
}

const SAFE_HOSTS = new Set([
  "developer.mozilla.org",
  "github.com",
  "raw.githubusercontent.com",
  "opencode.ai",
  "nodejs.org",
  "bun.sh",
  "typescriptlang.org",
  "react.dev",
  "nextjs.org",
  "tailwindcss.com",
  "prisma.io",
  "developer.chrome.com",
  "developers.google.com",
])

export async function gateUrl(nu: NormalizedUrl, rules: GateRule[]): Promise<Verdict | undefined> {
  // 1. HARD_DENY — non-HTTP(S) scheme
  if (nu.scheme !== "http" && nu.scheme !== "https") {
    return {
      decision: "deny",
      risk: 100,
      categories: ["non-http-scheme"],
      reason: "Non-HTTP(S) URL scheme blocked.",
    }
  }

  const host = stripTrailingDots(nu.hostname.toLowerCase())
  const bareHost = stripBrackets(host)

  // 2. HARD_DENY — cloud metadata endpoints (before the IPv6 blanket deny so the reason stays specific)
  if (isCloudMetadataHost(host)) {
    return {
      decision: "deny",
      risk: 100,
      categories: ["cloud-metadata-access"],
      reason: "Cloud metadata endpoint blocked (SSRF exfiltration target).",
    }
  }

  // 3. HARD_DENY — IPv6 literals (sidesteps IPv4-mapped/NAT64/6to4/Teredo bypasses)
  if (host.startsWith("[") || bareHost.includes(":")) {
    return {
      decision: "deny",
      risk: 100,
      categories: ["ssrf/internal-network", "ipv6-literal-destination"],
      reason: "IPv6 literal destinations are blocked by policy (SSRF bypass prevention).",
    }
  }

  const url = new URL(nu.href)

  // 4. HARD_DENY — credentials in the authority component
  if (url.username !== "" || url.password !== "") {
    return {
      decision: "deny",
      risk: 90,
      categories: ["credential-bearing-url"],
      reason: "Credentials embedded in URL authority.",
    }
  }

  // 5. SECRET_DENY — high-confidence secret query parameter names (ask, not deny: presigned URLs are legitimate)
  for (const [name] of url.searchParams) {
    if (SECRET_QUERY_NAMES.has(canonicalParamName(name))) {
      return {
        decision: "ask",
        risk: 70,
        categories: ["exfiltration-of-secrets-via-url", "credential-bearing-url"],
        reason: "URL contains a secret-looking parameter; confirm before fetching.",
      }
    }
  }

  // 6. Config rules (webfetch-rules.json), last-match-wins. The required
  // "*": "ask" sentinel defers unmatched URLs to this gate and therefore
  // never replaces a more specific match.
  const rule = matchUrlRule(nu.href, rules)
  if (rule) {
    return {
      decision: rule.action,
      risk: rule.action === "deny" ? 85 : rule.action === "ask" ? 40 : 10,
      categories: ["user-permission-rule"],
      reason: `Matched webfetch rule "${rule.pattern}": "${rule.action}".`,
    }
  }

  // 7. SAFE_HOSTS allowlist — DNS-verified: a poisoned allowlisted name must not skip the IP gate
  const isIpv4Literal = /^\d+\.\d+\.\d+\.\d+$/.test(bareHost)
  let ips: string[] | null = null
  if (SAFE_HOSTS.has(host)) {
    ips = await resolveHostIps(host)
    if (ips.length > 0 && ips.every((ip) => !isPrivateIp(ip))) {
      return {
        decision: "allow",
        risk: 5,
        categories: ["read-only"],
        reason: "Recognized safe read-only public documentation host.",
      }
    }
  }

  // 8. Private-network destinations (loopback/RFC1918/CGNAT/link-local, literal or DNS-resolved) — ask, not deny
  if (isPrivateHost(host)) {
    return {
      decision: "ask",
      risk: 60,
      categories: ["ssrf/internal-network"],
      reason: "Destination is a private/local-network address; confirm before fetching.",
    }
  }
  if (!isIpv4Literal) {
    if (ips === null) ips = await resolveHostIps(host)
    if (ips.length === 0) {
      return {
        decision: "ask",
        risk: 60,
        categories: ["ssrf/internal-network", "dns-resolution-failed"],
        reason: "DNS resolution failed; treating the destination as untrusted.",
      }
    }
    if (ips.some((ip) => isPrivateIp(ip))) {
      return {
        decision: "ask",
        risk: 60,
        categories: ["ssrf/internal-network"],
        reason: "Destination is a private/local-network address; confirm before fetching.",
      }
    }
  }

  // 9. Fall through — LLM classifier
  return undefined
}
