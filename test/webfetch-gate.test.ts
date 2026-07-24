import dns from "node:dns"
import {
  gateUrl,
  isCloudMetadataHost,
  isPrivateHost,
  isPrivateIp,
  matchUrlPattern,
  matchUrlRule,
  normalizeUrl,
  redactUrl,
  toGateRules,
} from "../plugin/webfetch/gate.ts"

let passed = 0
let failed = 0

function report(ok: boolean, name: string, detail: string): void {
  if (ok) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name} — ${detail}`)
  }
}

type GateOutcome = {
  decision: "allow" | "ask" | "deny" | "llm"
  risk: number
  note: string
}

async function decisionOf(url: string): Promise<GateOutcome> {
  const nu = normalizeUrl(url)
  if (!nu) return { decision: "deny", risk: 100, note: "unparseable" }
  const verdict = await gateUrl(nu, [])
  if (!verdict) return { decision: "llm", risk: -1, note: "fell through to LLM" }
  return { decision: verdict.decision, risk: verdict.risk, note: verdict.reason }
}

async function expectDecision(name: string, url: string, expected: GateOutcome["decision"], risk?: number): Promise<void> {
  const got = await decisionOf(url)
  const ok = got.decision === expected && (risk === undefined || got.risk === risk)
  report(ok, name, `expected ${expected}${risk === undefined ? "" : ` risk ${risk}`}, got ${got.decision} risk ${got.risk} (${got.note})`)
}

const online = await (async () => {
  try {
    const results = await dns.promises.lookup("github.com", { all: true, verbatim: true })
    return results.length > 0
  } catch {
    return false
  }
})()
console.log(`network: ${online ? "online" : "offline — DNS-dependent assertions degraded gracefully"}`)

// --- deterministic unit checks (offline-proof) ---
report(isPrivateIp("127.0.0.1"), "unit isPrivateIp 127.0.0.1", "expected true")
report(isPrivateIp("10.1.2.3"), "unit isPrivateIp 10.1.2.3", "expected true")
report(isPrivateIp("172.16.0.1") && isPrivateIp("172.31.255.255"), "unit isPrivateIp 172.16/12 bounds", "expected true")
report(!isPrivateIp("172.15.0.1") && !isPrivateIp("172.32.0.1"), "unit isPrivateIp 172.15/172.32 outside", "expected false")
report(isPrivateIp("192.168.0.1"), "unit isPrivateIp 192.168.0.1", "expected true")
report(isPrivateIp("169.254.1.2"), "unit isPrivateIp 169.254 link-local", "expected true")
report(isPrivateIp("100.64.0.1") && isPrivateIp("100.127.255.254"), "unit isPrivateIp CGNAT bounds", "expected true")
report(!isPrivateIp("100.63.0.1") && !isPrivateIp("100.128.0.1"), "unit isPrivateIp CGNAT outside", "expected false")
report(isPrivateIp("0.0.0.0"), "unit isPrivateIp 0.0.0.0", "expected true")
report(!isPrivateIp("8.8.8.8") && !isPrivateIp("1.1.1.1"), "unit isPrivateIp public v4", "expected false")
report(isPrivateIp("::1") && isPrivateIp("::"), "unit isPrivateIp v6 loopback/unspecified", "expected true")
report(isPrivateIp("fc00::1") && isPrivateIp("fd12::3456"), "unit isPrivateIp fc00::/7", "expected true")
report(isPrivateIp("fe80::abc"), "unit isPrivateIp fe80::/10", "expected true")
report(!isPrivateIp("fe00::1"), "unit isPrivateIp fe00 outside fe80/10", "expected false")
report(isPrivateIp("::ffff:127.0.0.1") && isPrivateIp("::ffff:7f00:1"), "unit isPrivateIp v4-mapped", "expected true")
report(!isPrivateIp("::ffff:8.8.8.8"), "unit isPrivateIp v4-mapped public", "expected false")
report(isPrivateHost("localhost") && isPrivateHost("api.localhost"), "unit isPrivateHost localhost forms", "expected true")
report(isPrivateHost("localhost.") && isPrivateHost("LOCALHOST"), "unit isPrivateHost trailing-dot/case", "expected true")
report(isPrivateHost("127.0.0.1") && !isPrivateHost("8.8.8.8") && !isPrivateHost("example.com"), "unit isPrivateHost ip/domain", "expected mismatch")
report(isCloudMetadataHost("169.254.169.254") && isCloudMetadataHost("metadata.google.internal"), "unit metadata aws/gcp", "expected true")
report(isCloudMetadataHost("metadata") && isCloudMetadataHost("metadata.azure.com") && isCloudMetadataHost("[fd00:ec2::254]"), "unit metadata generic/azure/v6", "expected true")
report(!isCloudMetadataHost("example.com"), "unit metadata negative", "expected false")
report(matchUrlPattern("https://github.com/foo/bar", "https://github.com/*"), "unit glob star", "expected true")
report(!matchUrlPattern("https://github.com/foo", "https://gitlab.com/*"), "unit glob negative", "expected false")
report(matchUrlPattern("https://x.com/ab", "https://x.com/a?"), "unit glob single-char ?", "expected true")
report(!matchUrlPattern("https://x.com/abc", "https://x.com/a?"), "unit glob ? is exactly one char", "expected false")
{
  const rules = toGateRules({ "https://a.com/*": "deny", "*": "ask", "https://a.com/ok": "allow" })
  const lastWins = matchUrlRule("https://a.com/ok", rules)
  report(lastWins?.action === "allow", "unit rules last-match-wins", `expected allow, got ${lastWins?.action}`)
  const denied = matchUrlRule("https://a.com/other", rules)
  report(denied?.action === "deny", "unit rules earlier deny still matches", `expected deny, got ${denied?.action}`)
  const deferred = matchUrlRule("https://b.com/", rules)
  report(deferred === undefined, "unit rules *:ask defers", `expected undefined, got ${deferred?.action}`)
  report(toGateRules({ x: "bogus" }).length === 0 && toGateRules("nope").length === 0, "unit toGateRules rejects junk", "expected []")
}

// --- nasty-URL corpus ---
await expectDecision("corpus decimal ipv4", "http://2130706433/", "ask", 60)
await expectDecision("corpus hex ipv4", "http://0x7f000001/", "ask", 60)
await expectDecision("corpus octal ipv4", "http://0177.0.0.1/", "ask", 60)
await expectDecision("corpus short ipv4", "http://127.1/", "ask", 60)
await expectDecision("corpus nip.io rebound", "http://127.0.0.1.nip.io/", "ask", 60)
await expectDecision("corpus localhost", "http://localhost/", "ask", 60)
await expectDecision("corpus localhost trailing dot", "http://localhost.:3000/", "ask", 60)
await expectDecision("corpus aws metadata", "http://169.254.169.254/latest/meta-data/", "deny", 100)
await expectDecision("corpus gcp metadata", "http://metadata.google.internal/", "deny", 100)
await expectDecision("corpus file scheme", "file:///etc/passwd", "deny", 100)
await expectDecision("corpus data scheme", "data:text/html,<script>alert(1)</script>", "deny", 100)
await expectDecision("corpus ftp scheme", "ftp://example.com/", "deny", 100)
await expectDecision("corpus userinfo", "https://user:pass@example.com/", "deny", 90)
await expectDecision("corpus secret query param", "https://example.com/?api_key=SECRET&q=hello", "ask", 70)
await expectDecision("corpus encoded secret param name", "https://example.com/?api%5Fkey=SECRET", "ask", 70)

{
  const nu = normalizeUrl("https://example.com/?api_key=SECRET&q=hello")
  const redacted = nu ? redactUrl(nu) : ""
  report(!redacted.includes("SECRET") && !redacted.includes("hello"), "redact hides query values", `got ${redacted}`)
  report(redacted.includes("api_key=") && redacted.startsWith("https://example.com/"), "redact keeps scheme/host/path/names", `got ${redacted}`)
}
{
  const nu = normalizeUrl("https://example.com/?api%5Fkey=SECRET")
  const redacted = nu ? redactUrl(nu) : ""
  report(!redacted.includes("SECRET"), "redact hides decoded-name value", `got ${redacted}`)
}
{
  const nu = normalizeUrl("https://example.com/path#access_token=leak")
  const redacted = nu ? redactUrl(nu) : ""
  report(!redacted.includes("#") && !redacted.includes("leak"), "redact strips fragment", `got ${redacted}`)
}

// safe hosts: allow only when DNS confirms public; offline degrades to ask (fail closed), never deny
{
  const mdn = await decisionOf("https://developer.mozilla.org/en-US/docs/Web")
  const ok = online ? mdn.decision === "allow" : mdn.decision !== "deny"
  report(ok, "corpus safe host mdn", `online=${online} got ${mdn.decision} (${mdn.note})`)
}
{
  const gh = await decisionOf("https://github.com/foo/bar")
  const ok = online ? gh.decision === "allow" : gh.decision !== "deny"
  report(ok, "corpus safe host github", `online=${online} got ${gh.decision} (${gh.note})`)
}

// unknown public host: must NOT be allowed by the deterministic gate (falls to LLM online, fail-closed ask offline)
{
  const got = await decisionOf("https://attacker.com/?d=somethinglong")
  const ok = online ? got.decision === "llm" : got.decision !== "allow"
  report(ok, "corpus unknown host not allowed", `online=${online} got ${got.decision} (${got.note})`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
