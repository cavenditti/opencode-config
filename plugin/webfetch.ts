import { tool } from "@opencode-ai/plugin"
import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import type { Part, TextPart, UserMessage } from "@opencode-ai/sdk"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PermissionRetryGate,
  retryEpoch,
  type RetryContext,
  type RetryIdentity,
  type RetryStatus,
} from "./permission-gate/index.ts"
import {
  gateUrl,
  normalizeUrl,
  redactUrl,
  toGateRules,
  type GateRule,
  type NormalizedUrl,
  type Verdict,
} from "./webfetch/gate.ts"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const MAX_REDIRECTS = 10
const MAX_USER_MESSAGE_LENGTH = 1500
const MAX_INTENT_LENGTH = 200
const CLASSIFIER_TIMEOUT_MS = 8000
const CLASSIFIER_MODEL = "deepseek/deepseek-v4-flash"

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type CachedUserMessage = { text: string; ts: number; messageID?: string }
type SafetyRecord = {
  url: string
  decision: Verdict["decision"]
  risk: number
  categories: string[]
  reason: string
  classifierEscalated: boolean
  retry?: RetryStatus
  permissionRequested?: boolean
}

const userMessageCache = new Map<string, CachedUserMessage>()
const permissionGate = new PermissionRetryGate()

function isUserRoleMessage(message: UserMessage): boolean {
  return message.role === "user"
}

function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function cacheUserMessage(sessionID: string, text: string, messageID?: string): void {
  if (!userMessageCache.has(sessionID) && userMessageCache.size >= 16) {
    let oldest: { key: string; ts: number } | undefined
    for (const [key, value] of userMessageCache) {
      if (!oldest || value.ts < oldest.ts) oldest = { key, ts: value.ts }
    }
    if (oldest) userMessageCache.delete(oldest.key)
  }
  const previous = userMessageCache.get(sessionID)
  if (!previous || previous.messageID !== messageID || previous.text !== text) permissionGate.resetSession(sessionID)
  userMessageCache.set(sessionID, { text: text.slice(0, MAX_USER_MESSAGE_LENGTH), ts: Date.now(), messageID })
}

async function chatMessageHook(
  input: { sessionID: string; messageID?: string },
  output: { message: UserMessage; parts: Part[] },
): Promise<void> {
  try {
    if (!output.message || !isUserRoleMessage(output.message)) return
    const text = extractTextFromParts(output.parts).trim()
    if (text) cacheUserMessage(input.sessionID, text, input.messageID ?? output.message.id)
  } catch {
    // Context is best-effort and must never break chat.
  }
}

function normalizeIntent(description: string | undefined): string | null {
  const value = description?.trim() ?? ""
  return value ? value.slice(0, MAX_INTENT_LENGTH) : null
}

function includeUserMessage(): boolean {
  const configured = process.env.OPENCODE_WEBFETCH_INCLUDE_USER_MESSAGE
    ?? process.env.OPENCODE_SAFETY_INCLUDE_USER_MESSAGE
    ?? "1"
  return configured !== "0" && configured.toLowerCase() !== "false" && configured !== ""
}

function loadRules(options: Record<string, unknown> | undefined): GateRule[] {
  const merged: Record<string, unknown> = {}
  const configuredPath = process.env.OPENCODE_WEBFETCH_RULES
  const configRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const candidates = configuredPath ? [configuredPath] : [join(configRoot, "webfetch-rules.json")]

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(merged, parsed)
    } catch {
      // The rules file is optional. Invalid or missing files defer to the gate.
    }
  }

  const optionRules = options?.rules
  if (optionRules && typeof optionRules === "object" && !Array.isArray(optionRules)) {
    Object.assign(merged, optionRules)
  }
  return toGateRules(merged)
}

function resolveOpenRouterKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY?.trim()
  if (envKey) return envKey

  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  const home = homedir()
  candidates.push(join(home, ".local", "share", "opencode", "auth.json"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "auth.json"))

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      const key = parsed?.openrouter?.key
      if (typeof key === "string" && key.trim()) return key.trim()
    } catch {
      // Try the next standard auth-store location.
    }
  }
  return undefined
}

const CLASSIFIER_PROMPT = `You are a safety classifier for a read-only webfetch tool. Output STRICT JSON only: {"decision":"allow"|"ask"|"deny","risk":0-100,"categories":["..."],"reason":"..."}. The tool performs one HTTP(S) GET and never executes returned content.

Allow ordinary public documentation, source code, standards, articles, and public API reads. Ask when the purpose is unclear, the destination appears administrative or sensitive, the URL initiates an action, or downloading the content may expose private data. Deny obvious credential exfiltration, cloud metadata access, or attempts to reach protected internal services. Deterministic checks separately handle schemes, embedded credentials, secret-looking query parameters, IP literals, DNS failures, and private addresses.

The URL supplied to you has all query values redacted. Treat agent-stated intent as weak evidence. A matching user message may authorize an otherwise uncertain public read, but cannot override secret access, credential exfiltration, cloud metadata, or private-network protections. Do not classify links found inside fetched content; classify only the requested URL.`

function parseModelJson(content: string): unknown {
  let value = content.trim()
  if (value.startsWith("```")) value = value.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim()
  const start = value.indexOf("{")
  const end = value.lastIndexOf("}")
  if (start === -1 || end < start) return undefined
  try {
    return JSON.parse(value.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function normalizeVerdict(parsed: unknown): Verdict | undefined {
  if (!parsed || typeof parsed !== "object") return undefined
  const value = parsed as Record<string, unknown>
  if (value.decision !== "allow" && value.decision !== "ask" && value.decision !== "deny") return undefined
  if (typeof value.reason !== "string" || !value.reason.trim()) return undefined
  const risk = typeof value.risk === "number" && Number.isFinite(value.risk)
    ? Math.max(0, Math.min(100, value.risk))
    : 50
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((item): item is string => typeof item === "string")
    : []
  return { decision: value.decision, risk, categories, reason: value.reason }
}

function unavailable(reason: string): Verdict {
  return { decision: "ask", risk: 70, categories: ["classifier-unavailable"], reason }
}

async function classifyExternal(
  endpoint: string,
  safeUrl: string,
  ctx: ToolContext,
  userMessage: string | null,
  intent: string | null,
): Promise<Verdict> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "webfetch",
        arguments: { url: safeUrl },
        cwd: ctx.directory,
        worktree: ctx.worktree,
        context: { userMessage, intent },
        policy: { allowedDecisions: ["allow", "ask", "deny"], askOnUncertainty: true, readOnly: true },
      }),
      signal: ctx.abort,
    })
    if (!response.ok) return unavailable(`External classifier returned HTTP ${response.status}.`)
    return normalizeVerdict(await response.json()) ?? unavailable("External classifier returned an invalid response.")
  } catch (error) {
    return unavailable(`External classifier request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function classifyOpenRouter(
  safeUrl: string,
  ctx: ToolContext,
  userMessage: string | null,
  intent: string | null,
): Promise<Verdict> {
  const apiKey = resolveOpenRouterKey()
  if (!apiKey) return unavailable("No OpenRouter API key found in the environment or OpenCode auth store.")

  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), CLASSIFIER_TIMEOUT_MS)
  const signal = AbortSignal.any([timeoutController.signal, ctx.abort])
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        temperature: 0,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CLASSIFIER_PROMPT },
          { role: "user", content: JSON.stringify({ url: safeUrl, userMessage, intent }) },
        ],
      }),
      signal,
    })
    if (!response.ok) return unavailable(`OpenRouter returned HTTP ${response.status}.`)
    const body = await response.json()
    const content = typeof body?.choices?.[0]?.message?.content === "string" ? body.choices[0].message.content : ""
    return normalizeVerdict(parseModelJson(content)) ?? unavailable("Classifier response was not valid verdict JSON.")
  } catch (error) {
    if (timeoutController.signal.aborted && !ctx.abort.aborted) {
      return unavailable(`Safety classifier timed out after ${CLASSIFIER_TIMEOUT_MS / 1000} seconds.`)
    }
    return unavailable(`Safety classifier request failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function classifyUrl(
  safeUrl: string,
  ctx: ToolContext,
  userMessage: string | null,
  intent: string | null,
): Promise<Verdict> {
  const external = process.env.OPENCODE_WEBFETCH_SAFETY_URL ?? process.env.OPENCODE_SAFETY_URL
  return external
    ? classifyExternal(external, safeUrl, ctx, userMessage, intent)
    : classifyOpenRouter(safeUrl, ctx, userMessage, intent)
}

function getRetryContext(ctx: ToolContext): RetryContext {
  const cached = userMessageCache.get(ctx.sessionID)
  return {
    sessionID: ctx.sessionID,
    agent: ctx.agent,
    epoch: retryEpoch(cached?.messageID, cached?.ts),
  }
}

function permissionFamily(verdict: Verdict): string {
  const categories = verdict.categories.join(" ")
  if (/secret|credential/i.test(categories)) return "sensitive-query"
  if (/ssrf|internal-network|dns-resolution-failed/i.test(categories)) return "network-boundary"
  if (/user-permission-rule/i.test(categories)) return "configured-rule"
  if (/classifier-unavailable/i.test(categories)) return "classifier-unavailable"
  return "classifier"
}

function authorizationScope(normalized: NormalizedUrl, verdict: Verdict): string {
  return `webfetch:${normalized.scheme}://${normalized.host}:${permissionFamily(verdict)}`
}

function getRetryIdentity(
  ctx: ToolContext,
  normalized: NormalizedUrl,
  verdict: Verdict,
  requestScope: string,
): RetryIdentity {
  return {
    ...getRetryContext(ctx),
    scope: `${authorizationScope(normalized, verdict)}:${requestScope}`,
    binding: requestScope,
  }
}

type AuthorizationMode =
  | { kind: "standard"; requestScope: string }
  | { kind: "permission"; requestID: string; requestScope: string; approvedScopes: Set<string> }

type AuthorizationResult =
  | { allowed: true; normalized: NormalizedUrl; safety: SafetyRecord }
  | { allowed: false; safety: SafetyRecord; retry: RetryStatus }

function deniedWebfetchResult(safety: SafetyRecord, retry: RetryStatus) {
  const next = retry.spent
    ? "Permission escalation was already used for this destination in the current user turn. Wait for new user instructions."
    : retry.requestID
      ? `Permission escalation is available. Call webfetch_request_permission with request_id ${JSON.stringify(retry.requestID)} and the same fetch arguments.`
      : "Try a safer public source or revise the URL before retrying."
  return {
    title: "Web fetch not executed — permission required",
    output: [
      "NOT EXECUTED",
      "",
      `URL: ${safety.url}`,
      `Reason: ${safety.reason}`,
      `Risk: ${safety.risk}`,
      `Categories: ${safety.categories.join(", ") || "unspecified"}`,
      `Attempts: ${Math.min(retry.attempts, retry.threshold)}/${retry.threshold}`,
      "",
      next,
    ].join("\n"),
    metadata: { safety },
  }
}

function consumeUnusedPermissionToken(mode: AuthorizationMode, context: ToolContext): void {
  if (mode.kind !== "permission") return
  if (permissionGate.validateContext(getRetryContext(context), mode.requestID, mode.requestScope) !== undefined) return
  permissionGate.consumeContext(getRetryContext(context), mode.requestID, mode.requestScope)
}

async function authorizeUrl(
  rawUrl: string,
  rules: GateRule[],
  ctx: ToolContext,
  userMessage: string | null,
  intent: string | null,
  mode: AuthorizationMode,
): Promise<AuthorizationResult> {
  const normalized = normalizeUrl(rawUrl)
  if (!normalized) throw new Error("Blocked by webfetch safety policy: invalid URL.")
  const safeUrl = redactUrl(normalized)
  const deterministic = await gateUrl(normalized, rules)
  let verdict = deterministic ?? await classifyUrl(safeUrl, ctx, userMessage, intent)
  let classifierEscalated = false

  if (!deterministic && verdict.decision === "deny") {
    classifierEscalated = true
    verdict = {
      decision: "ask",
      risk: verdict.risk,
      categories: [...new Set([...verdict.categories, "classifier-deny-escalation"])],
      reason: `Classifier denied this fetch: ${verdict.reason} Explicit permission is required.`,
    }
  }

  if (verdict.decision === "deny") {
    const safety: SafetyRecord = { url: safeUrl, ...verdict, classifierEscalated }
    ctx.metadata({ title: `Web fetch: deny — ${safeUrl}`, metadata: { safety } })
    throw new Error(`Blocked by webfetch safety policy: ${verdict.reason}`)
  }

  if (verdict.decision === "ask") {
    const scope = authorizationScope(normalized, verdict)
    const identity = getRetryIdentity(ctx, normalized, verdict, mode.requestScope)
    if (mode.kind === "standard") {
      const retry = permissionGate.record(identity)
      const safety: SafetyRecord = { url: safeUrl, ...verdict, classifierEscalated, retry }
      ctx.metadata({ title: `Web fetch: permission required — ${safeUrl}`, metadata: { safety } })
      return { allowed: false, safety, retry }
    }

    if (!mode.approvedScopes.has(scope)) {
      const invalid = permissionGate.validate(identity, mode.requestID)
      if (invalid) throw new Error(`${invalid} Call the standard webfetch tool and follow its retry guidance.`)
      const consumeError = permissionGate.consume(identity, mode.requestID)
      if (consumeError) throw new Error(consumeError)
      await ctx.ask({
        permission: "webfetch",
        patterns: [safeUrl],
        always: [],
        metadata: {
          url: safeUrl,
          "agent-stated intent": intent ?? "(not provided)",
          risk: verdict.risk,
          categories: verdict.categories,
          reason: verdict.reason,
          retryThresholdSatisfied: true,
          ...(classifierEscalated ? { escalated: true } : {}),
        },
      })
      mode.approvedScopes.add(scope)
    }
  }

  const safety: SafetyRecord = {
    url: safeUrl,
    ...verdict,
    classifierEscalated,
    permissionRequested: mode.kind === "permission" && verdict.decision === "ask",
  }
  ctx.metadata({ title: `Web fetch: ${verdict.decision} — ${safeUrl}`, metadata: { safety } })
  return { allowed: true, normalized, safety }
}

function acceptHeader(format: "text" | "markdown" | "html"): string {
  if (format === "markdown") return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
  if (format === "text") return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
  return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
}

function requestHeaders(format: "text" | "markdown" | "html", honestUserAgent = false): Record<string, string> {
  return {
    "User-Agent": honestUserAgent
      ? "opencode"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: acceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  }
}

async function fetchOnce(url: string, format: "text" | "markdown" | "html", signal: AbortSignal): Promise<Response> {
  let response = await fetch(url, { headers: requestHeaders(format), redirect: "manual", signal })
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    await response.body?.cancel()
    response = await fetch(url, { headers: requestHeaders(format, true), redirect: "manual", signal })
  }
  return response
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_SIZE) {
    throw new Error("Response too large (exceeds 5MB limit)")
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)")
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function extractTextFromHTML(html: string): string {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(value) {
      if (skipDepth === 0) text += value
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  service.remove(["script", "style", "meta", "link"])
  return service.turndown(html)
}

type WebfetchArgs = {
  url: string
  format: "text" | "markdown" | "html"
  timeout?: number
  description?: string
}

async function executeWebfetch(
  args: WebfetchArgs,
  context: ToolContext,
  rules: GateRule[],
  mode: AuthorizationMode,
) {
  const timeoutSeconds = Math.min(Math.max(args.timeout ?? DEFAULT_TIMEOUT_SECONDS, 0.001), MAX_TIMEOUT_SECONDS)
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutSeconds * 1000)
  const signal = AbortSignal.any([timeoutController.signal, context.abort])
  const userMessage = includeUserMessage() ? (userMessageCache.get(context.sessionID)?.text ?? null) : null
  const intent = normalizeIntent(args.description)
  const safety: SafetyRecord[] = []
  let current = args.url
  let response: Response | undefined

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const authorization = await authorizeUrl(current, rules, context, userMessage, intent, mode)
      if (!authorization.allowed) return deniedWebfetchResult(authorization.safety, authorization.retry)
      safety.push(authorization.safety)
      response = await fetchOnce(authorization.normalized.href, args.format, signal)

      if (!REDIRECT_STATUSES.has(response.status)) break
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location) throw new Error(`Redirect response ${response.status} did not include a Location header`)
      if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`)
      current = new URL(location, authorization.normalized.href).href
    }

    if (!response) throw new Error("Web fetch produced no response")
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status} ${response.statusText}`.trim())
    const bytes = await readLimited(response)
    const contentType = response.headers.get("content-type") ?? ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    const finalUrl = safety.at(-1)?.url ?? redactUrl(normalizeUrl(current)!)
    const title = `${finalUrl} (${contentType || "unknown content type"})`

    if (IMAGE_MIMES.has(mime)) {
      consumeUnusedPermissionToken(mode, context)
      return {
        title,
        output: "Image fetched successfully",
        metadata: { safety, redirects: Math.max(0, safety.length - 1) },
        attachments: [{ type: "file" as const, mime, url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` }],
      }
    }

    const content = new TextDecoder().decode(bytes)
    const output = args.format === "markdown" && contentType.includes("text/html")
      ? convertHTMLToMarkdown(content)
      : args.format === "text" && contentType.includes("text/html")
        ? extractTextFromHTML(content)
        : content
    consumeUnusedPermissionToken(mode, context)
    return { title, output, metadata: { safety, redirects: Math.max(0, safety.length - 1) } }
  } catch (error) {
    if (timeoutController.signal.aborted && !context.abort.aborted) throw new Error("Request timed out")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const webfetchArgs = {
  url: tool.schema.string().min(1).describe("The URL to fetch content from"),
  format: tool.schema.enum(["text", "markdown", "html"]).default("markdown").describe("Output format; defaults to markdown"),
  timeout: tool.schema.number().optional().describe("Optional timeout in seconds (max 120)"),
  description: tool.schema.string().optional().describe("One short sentence stating why this URL is being fetched"),
}

function webfetchRequestScope(args: WebfetchArgs): string {
  const normalized = normalizeUrl(args.url)
  return createHash("sha256")
    .update(JSON.stringify([normalized?.href ?? args.url.trim(), args.format, args.timeout ?? DEFAULT_TIMEOUT_SECONDS]))
    .digest("hex")
}

export default (async (_input, options = {}) => {
  const rules = loadRules(options)
  return {
    tool: {
      webfetch: tool({
        description: "Non-interactive HTTP(S) fetch with SSRF, credential, redirect, and classifier checks. Safe fetches run automatically. Fetches requiring permission are not executed; the denial reason and retry status are returned. Use webfetch_request_permission only after this tool returns a request_id.",
        args: webfetchArgs,
        execute(args, context) {
          return executeWebfetch(args, context, rules, { kind: "standard", requestScope: webfetchRequestScope(args) })
        },
      }),
      webfetch_request_permission: tool({
        description: "Request one-shot user permission for a fetch only after webfetch has denied the destination enough times and returned a request_id. Never use proactively. Redirects and hard-deny rules are rechecked.",
        args: {
          ...webfetchArgs,
          request_id: tool.schema.string().min(1).describe("Opaque request_id returned by the standard webfetch tool after repeated denials"),
        },
        async execute(args, context) {
          const requestScope = webfetchRequestScope(args)
          const invalid = permissionGate.validateContext(getRetryContext(context), args.request_id, requestScope)
          if (invalid) throw new Error(`${invalid} Call the standard webfetch tool and follow its retry guidance.`)
          return executeWebfetch(args, context, rules, {
            kind: "permission",
            requestID: args.request_id,
            requestScope,
            approvedScopes: new Set<string>(),
          })
        },
      }),
    },
    "chat.message": chatMessageHook,
  }
}) satisfies Plugin
