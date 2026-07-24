/**
 * plugin/memory/extraction.ts — low-cost extraction model over evidence batches.
 *
 * The extractor transforms a window of evidence events into structured
 * ExtractionResult JSON. It does NOT approve memories, search backends,
 * delete memories, or write canonical storage. Its output is validated and
 * becomes pending candidates. Uses OpenRouter (same key resolution as the
 * safety classifier). Fails safe: invalid output never enters memory.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { MemoryConfig } from "./config.ts"
import type { EventRow } from "./journal.ts"
import type { MemoryStore } from "./store.ts"
import type { ExtractionResult, SessionCapsule, MemoryScope } from "./domain.ts"
import { statementHash } from "./domain.ts"

function resolveOpenRouterKey(config: MemoryConfig): string | undefined {
  if (config.extraction.apiKey) return config.extraction.apiKey
  const envKey = process.env[config.extraction.apiKeyEnv]?.trim()
  if (envKey) return envKey
  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  const home = homedir()
  candidates.push(join(home, ".local", "share", "opencode", "auth.json"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "auth.json"))
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw)
      const key = parsed?.openrouter?.key
      if (typeof key === "string" && key.trim()) return key.trim()
    } catch {
      // try next
    }
  }
  return undefined
}

const SYSTEM_PROMPT = `You are a memory extraction engine for a coding agent system. You receive a window of evidence events from an OpenCode session and MUST output STRICT JSON matching the given schema.

Hard rules:
- Every extracted claim MUST cite one or more evidenceEventIds that actually appear in the input. A claim with no cited evidence is invalid.
- Never reproduce secrets, API keys, tokens, or credential file contents. If evidence contains a redacted value, treat it as unknown.
- A command that succeeded once is an OBSERVATION, not a universal procedure. Only promote to "procedure" when the evidence shows verification or repetition.
- Failed attempts MUST NOT become procedures. They may become "incident" or "lesson" memories.
- Hypotheses and unverified assumptions MUST remain kind:"hypothesis", never "fact" or "decision".
- User corrections override earlier agent assumptions. Record the corrected view, and if it contradicts an earlier claim, emit a contradiction.
- Branch-specific facts MUST be scoped to that branch. Do not generalize a branch-local fact to the repository.
- File-derived claims should be commit-bounded when practical (set validFrom/validUntil to commit shas if known).
- Ignore low-value transient details (intermediate streaming, repeated identical errors, build noise). Put them in ignoredObservations.
- Keep statements atomic and self-contained (a single searchable proposition), entity-centric, under 60 words.
- scope must reflect WHERE the claim holds: set repositoryId/branch/sessionId from the evidence when the claim is tied to that context; omit fields that don't apply.
- confidence is 0..1: how well the evidence supports THIS claim.
- importance: low/medium/high based on reuse value.
- reviewRecommendation: "auto_observational" for bounded deterministic facts (a command exited 0, a test failed with error X, a file changed); "auto_accept" only for explicit user requirements clearly stated in a user message; "agent_review" for inferred procedures/lessons/decisions; "human_review" for global preferences or security policy.
Output JSON ONLY. No prose, no markdown fences.`

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["candidates", "relations", "contradictions", "ignoredObservations"],
  properties: {
    capsulePatch: {
      type: "object",
      properties: {
        objective: { type: "string" },
        outcome: { type: "string", enum: ["completed", "partial", "failed", "abandoned", "ongoing"] },
        userRequirements: { type: "array", items: { type: "string" } },
        decisions: { type: "array", items: { type: "string" } },
        discoveries: { type: "array", items: { type: "string" } },
        failures: { type: "array", items: { type: "object", properties: { summary: { type: "string" }, errorCategory: { type: "string" } }, required: ["summary"] } },
        resolutions: { type: "array", items: { type: "object", properties: { problem: { type: "string" }, resolution: { type: "string" } }, required: ["problem", "resolution"] } },
        unresolvedQuestions: { type: "array", items: { type: "string" } },
        nextActions: { type: "array", items: { type: "string" } },
      },
    },
    candidates: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "statement", "scope", "evidenceEventIds", "confidence", "durability", "importance", "reviewRecommendation", "rationale"],
        properties: {
          kind: { type: "string", enum: ["fact", "decision", "requirement", "constraint", "preference", "procedure", "lesson", "incident", "hypothesis", "episode", "artifact", "relation"] },
          statement: { type: "string" },
          structuredPayload: { type: "object" },
          scope: {
            type: "object",
            properties: {
              userId: { type: "string" }, organizationId: { type: "string" },
              workspaceId: { type: "string" }, projectId: { type: "string" },
              repositoryId: { type: "string" }, repositoryRemote: { type: "string" },
              branch: { type: "string" }, worktreeId: { type: "string" },
              commitFrom: { type: "string" }, commitTo: { type: "string" },
              component: { type: "string" }, environment: { type: "string" },
              sessionId: { type: "string" },
            },
          },
          evidenceEventIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          durability: { type: "string", enum: ["session", "project", "long_term"] },
          validFrom: { type: "string" },
          validUntil: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
          reviewRecommendation: { type: "string", enum: ["auto_observational", "auto_accept", "agent_review", "human_review"] },
          rationale: { type: "string" },
        },
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        required: ["predicate", "confidence", "rationale"],
        properties: {
          subjectEventId: { type: "string" }, subjectStatementHash: { type: "string" },
          predicate: { type: "string", enum: ["depends_on", "supersedes", "contradicts", "supports", "related_to", "part_of", "caused_by", "alternative_to"] },
          objectEventId: { type: "string" }, objectStatementHash: { type: "string" },
          confidence: { type: "number" }, rationale: { type: "string" },
        },
      },
    },
    contradictions: {
      type: "array",
      items: {
        type: "object",
        required: ["candidateIndex", "conflictType", "explanation"],
        properties: {
          candidateIndex: { type: "integer" },
          conflictsWithStatementHash: { type: "string" },
          conflictsWithStatement: { type: "string" },
          conflictType: { type: "string", enum: ["direct_contradiction", "temporal_change", "scope_mismatch", "source_disagreement", "ambiguous"] },
          explanation: { type: "string" },
        },
      },
    },
    ignoredObservations: {
      type: "array",
      items: {
        type: "object",
        required: ["summary", "reason"],
        properties: { summary: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
}

export interface ExtractionContext {
  sessionScope: MemoryScope
  existingRelated: { id: string; statement: string; statementHash: string }[]
  capsule?: SessionCapsule
}

export async function extractFromBatch(
  events: EventRow[],
  ctx: ExtractionContext,
  store: MemoryStore,
  config: MemoryConfig,
): Promise<ExtractionResult> {
  if (events.length === 0) {
    return emptyResult()
  }

  const window = buildWindow(events, ctx, config)
  const apiKey = config.extraction.provider === "openrouter" ? resolveOpenRouterKey(config) : undefined
  if ((config.extraction.provider === "openrouter" && !apiKey) ||
      (config.extraction.provider === "external" && !config.extraction.externalUrl)) {
    // No key: degrade to deterministic observational memories only.
    return deterministicObservational(window, events)
  }

  const userPrompt = buildUserPrompt(window)
  const lastError = null
  for (let attempt = 0; attempt <= config.extraction.retryCount; attempt++) {
    try {
      const content = config.extraction.provider === "external"
        ? await callExternalExtractor(config, userPrompt, attempt === config.extraction.retryCount)
        : await callOpenRouter(config, apiKey!, userPrompt, attempt === config.extraction.retryCount)
      const parsed = parseJsonLenient(content)
      if (!parsed) {
        continue
      }
      const validated = validateExtractionShape(parsed as Record<string, unknown>)
      if (!validated) continue
      return validated as ExtractionResult
    } catch (error) {
      // retry
    }
  }
  // Fallback: deterministic observational extraction.
  return deterministicObservational(window, events)
}

async function callExternalExtractor(config: MemoryConfig, userPrompt: string, finalAttempt: boolean): Promise<string> {
  const model = finalAttempt && config.extraction.escalationModel ? config.extraction.escalationModel : config.extraction.model
  const headers: Record<string, string> = { "content-type": "application/json" }
  const apiKey = config.extraction.apiKey ?? process.env[config.extraction.apiKeyEnv]
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const res = await fetch(config.extraction.externalUrl!, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: config.extraction.temperature,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt.slice(0, config.extraction.maxInputTokens * 4),
      outputSchema: OUTPUT_SCHEMA,
    }),
    signal: AbortSignal.timeout(config.extraction.timeoutMs),
  })
  if (!res.ok) throw new Error(`external extraction HTTP ${res.status}`)
  const json = await res.json() as { content?: unknown; result?: unknown; candidates?: unknown }
  if (typeof json.content === "string") return json.content
  if (json.result && typeof json.result === "object") return JSON.stringify(json.result)
  if (Array.isArray(json.candidates)) return JSON.stringify(json)
  throw new Error("external extraction returned no content or result")
}

function buildWindow(events: EventRow[], ctx: ExtractionContext, config: MemoryConfig): { events: EventRow[]; related: ExtractionContext["existingRelated"]; capsule?: SessionCapsule; scope: MemoryScope } {
  return { events, related: ctx.existingRelated, capsule: ctx.capsule, scope: ctx.sessionScope }
}

function buildUserPrompt(window: { events: EventRow[]; related: ExtractionContext["existingRelated"]; capsule?: SessionCapsule; scope: MemoryScope }): string {
  const eventsCompact = window.events.map((e) => ({
    id: e.id, type: e.event_type, at: e.occurred_at, origin: e.origin,
    summary: e.summary, payload: e.payload,
  }))
  const relatedCompact = window.related.slice(0, 20).map((r) => ({ hash: r.statementHash, statement: r.statement }))
  const scopeStr = JSON.stringify(window.scope)
  const capsuleStr = window.capsule ? JSON.stringify({ objective: window.capsule.objective, outcome: window.capsule.outcome, decisions: window.capsule.decisions }) : "none"
  return `SESSION SCOPE: ${scopeStr}
CURRENT CAPSULE: ${capsuleStr}
EXISTING RELATED MEMORIES (for contradiction detection): ${JSON.stringify(relatedCompact)}
EVIDENCE WINDOW (${window.events.length} events):
${JSON.stringify(eventsCompact)}

Extract memories per the schema and rules. Every candidate MUST reference real evidenceEventIds from above.`
}

async function callOpenRouter(config: MemoryConfig, apiKey: string, userPrompt: string, finalAttempt: boolean): Promise<string> {
  const model = finalAttempt && config.extraction.escalationModel ? config.extraction.escalationModel : config.extraction.model
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.extraction.timeoutMs)
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: config.extraction.temperature,
        response_format: { type: "json_schema", json_schema: { name: "extraction_result", strict: true, schema: OUTPUT_SCHEMA } },
        reasoning: { enabled: false },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt.slice(0, config.extraction.maxInputTokens * 4) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`openrouter extraction HTTP ${res.status}`)
    }
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content
    return typeof content === "string" ? content : ""
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonLenient(content: string): unknown {
  let text = content.trim()
  if (!text) return null
  if (text.startsWith("```")) {
    text = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim()
  }
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first === -1 || last === -1 || last < first) return null
  try {
    return JSON.parse(text.slice(first, last + 1))
  } catch {
    return null
  }
}

function validateExtractionShape(parsed: Record<string, unknown>): ExtractionResult | null {
  if (!parsed || typeof parsed !== "object") return null
  const candidates = parsed.candidates
  if (!Array.isArray(candidates)) return null
  const relations = Array.isArray(parsed.relations) ? parsed.relations : []
  const contradictions = Array.isArray(parsed.contradictions) ? parsed.contradictions : []
  const ignored = Array.isArray(parsed.ignoredObservations) ? parsed.ignoredObservations : []
  const capsulePatch = parsed.capsulePatch && typeof parsed.capsulePatch === "object" ? parsed.capsulePatch : undefined
  return {
    capsulePatch: capsulePatch as Partial<SessionCapsule> | undefined,
    candidates: candidates as ExtractionResult["candidates"],
    relations: relations as ExtractionResult["relations"],
    contradictions: contradictions as ExtractionResult["contradictions"],
    ignoredObservations: ignored as ExtractionResult["ignoredObservations"],
  }
}

function emptyResult(): ExtractionResult {
  return { candidates: [], relations: [], contradictions: [], ignoredObservations: [] }
}

/** Deterministic fallback when no extraction model is available. Produces only
 *  bounded observational memories for completed tool calls and session
 *  outcomes — never generalized procedures or decisions. */
function deterministicObservational(_window: { events: EventRow[]; related: ExtractionContext["existingRelated"]; scope: MemoryScope }, events: EventRow[]): ExtractionResult {
  const candidates: ExtractionResult["candidates"] = []
  const ignored: ExtractionResult["ignoredObservations"] = []
  for (const e of events) {
    if (e.event_type === "tool.after" || e.event_type === "tool.error") {
      const payload = e.payload as { tool?: string; exitCode?: number; error?: string } | null
      const tool = payload?.tool ?? "unknown"
      const completed = e.event_type === "tool.after"
      if (tool === "unknown") continue
      candidates.push({
        kind: "fact",
        statement: `${tool} ${completed ? "completed" : "failed"}${payload?.exitCode != null ? ` (exit ${payload.exitCode})` : ""} in session ${e.session_id.slice(0, 8)}.`,
        scope: { sessionId: e.session_id },
        evidenceEventIds: [e.id],
        confidence: completed ? 0.95 : 0.9,
        durability: "session",
        importance: "low",
        reviewRecommendation: "auto_observational",
        rationale: "deterministically observed tool outcome",
      })
    } else if (e.event_type === "session.completed" || e.event_type === "session.failed") {
      candidates.push({
        kind: "episode",
        statement: `Session ${e.session_id.slice(0, 8)} reached outcome ${e.event_type === "session.completed" ? "completed" : "failed"}: ${e.summary}.`,
        scope: { sessionId: e.session_id },
        evidenceEventIds: [e.id],
        confidence: 0.95,
        durability: "session",
        importance: "low",
        reviewRecommendation: "auto_observational",
        rationale: "deterministically observed session outcome",
      })
    }
  }
  if (candidates.length === 0) {
    ignored.push({ summary: `${events.length} events produced no deterministic observations`, reason: "no qualifying tool/session outcomes" })
  }
  return { candidates, relations: [], contradictions: [], ignoredObservations: ignored }
}
