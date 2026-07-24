/**
 * plugin/memory/redaction.ts — secret redaction before journal persistence.
 *
 * Runs synchronously in the plugin's event hook before the evidence event is
 * written. Every event records whether redaction was applied, but never
 * retains the original secret. Layers: key-name matching, pattern matching,
 * path rules, and tool-specific filters.
 */
import type { RedactionResult, SensitivityClassification, CapturePolicy, RetentionClass } from "./domain.ts"

const KEY_NAMES = new Set([
  "authorization", "auth", "apikey", "api_key", "apikey", "api-key",
  "token", "access_token", "accesstoken", "refreshtoken", "refresh_token",
  "password", "passwd", "pwd", "secret", "clientsecret", "client_secret",
  "cookie", "cookies", "set-cookie", "privatekey", "private_key", "privkey",
  "session", "sessiontoken", "session_token", "bearer", "credential", "credentials",
  "accesskey", "access_key", "secretkey", "secret_key", "signature",
  "x-api-key", "x-auth-token", "x-amz-security-token", "anthropic-api-key",
  "openai_api_key", "openrouter_api_key", "supermemory_api_key",
  "connectionstring", "connection_string", "connstring",
])

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: "github-app", re: /\b(ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: "google-api", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "aws-access", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws-secret", re: /\bAKIA[0-9A-Z]{16}[\s\S]{0,200}?[A-Za-z0-9/+=]{40}\b/ },
  { name: "pem-private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "postgres-conn", re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i },
  { name: "mysql-conn", re: /mysql:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i },
  { name: "redis-conn", re: /rediss?:\/\/[^:\s]+:[^\s@]+@/i },
  { name: "mongodb-conn", re: /mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/i },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe-key", re: /\b(?:sk|pk)_(?:test_|live_)?[A-Za-z0-9]{20,}\b/ },
]

const SECRET_PATH_RE = /(?:^|[\"'\s=/(])(?:\.env|\.env\.\w+|\.npmrc|\.netrc|\.pypirc|\.p12|\.pfx|\.keystore|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.ssh\/[^/\s]+|\.aws\/credentials|\.aws\/config|\.gnupg\/[^/\s]+|\.kube\/config|\.docker\/config\.json|opencode[/.]auth\.json|\/etc\/(?:shadow|master\.passwd|sudoers)|credentials\.json|secrets?\.(?:json|ya?ml|toml|env))(?:\b|[\"'\s)/]|$)/i

const REDACTED = "[REDACTED]"

function redactString(s: string, applied: Set<string>): string {
  let out = s
  for (const { name, re } of PATTERNS) {
    if (re.test(out)) {
      applied.add(name)
      out = out.replace(re, REDACTED)
    }
  }
  return out
}

function redactValue(value: unknown, applied: Set<string>, depth = 0): unknown {
  if (depth > 8) return "[truncated]"
  if (typeof value === "string") return redactString(value, applied)
  if (value == null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, applied, depth + 1))
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase().replace(/[-\s]/g, "")
    if (KEY_NAMES.has(lk) || KEY_NAMES.has(k.toLowerCase())) {
      applied.add("key:" + k.toLowerCase())
      out[k] = REDACTED
    } else if (typeof v === "string" && SECRET_PATH_RE.test(v)) {
      applied.add("path-rule")
      out[k] = REDACTED
    } else {
      out[k] = redactValue(v, applied, depth + 1)
    }
  }
  return out
}

export function redactPayload(payload: unknown): { payload: unknown; result: RedactionResult } {
  const applied = new Set<string>()
  if (payload == null) {
    return { payload, result: { applied: false, fieldCount: 0, patterns: [] } }
  }
  const redacted = redactValue(payload, applied)
  return {
    payload: redacted,
    result: {
      applied: applied.size > 0,
      fieldCount: applied.size,
      patterns: [...applied],
    },
  }
}

export function redactStringInline(s: string): string {
  const applied = new Set<string>()
  return redactString(s, applied)
}

export function containsSecret(s: string): boolean {
  for (const { re } of PATTERNS) if (re.test(s)) return true
  return SECRET_PATH_RE.test(s)
}

export function classifySensitivity(payload: unknown): SensitivityClassification {
  if (payload == null) return "internal"
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  if (containsSecret(text)) return "restricted"
  if (/password|secret|token|key|credential/i.test(text)) return "confidential"
  return "internal"
}

export function capturePolicyFor(
  eventType: string,
  origin: string,
  sensitivity: SensitivityClassification,
): CapturePolicy {
  const isRestricted = sensitivity === "restricted"
  const isOperational = origin === "memory_extractor" || origin === "memory_reviewer"
  const extractionEligible = !isRestricted && !isOperational
  const memoryCapture = !isRestricted
  let retentionClass: RetentionClass = "standard"
  if (isRestricted) retentionClass = "ephemeral"
  else if (eventType.startsWith("session.")) retentionClass = "extended"
  else if (eventType === "memory.explicit" || eventType === "checkpoint.requested") retentionClass = "permanent"
  return { memoryCapture, extractionEligible, retentionClass }
}
