import assert from "node:assert"
import {
  normalizeStatement, statementHash, eventId, scopeKey, scopeCompatible,
  scopeMultiplier, scopeDepth, canTransition, rankResult, defaultRankingWeights,
  validatePropose, validateCandidate, isExpired, indexEligible, recencyMultiplier,
  evidenceMultiplier, actorRef, memoryId,
  type MemoryScope, type ExtractedCandidate,
} from "./domain.ts"
import { loadConfig } from "./config.ts"
import { redactPayload, containsSecret, classifySensitivity, capturePolicyFor } from "./redaction.ts"
import { captureFromEvent, type CaptureCtx, isGitCommitCommand } from "./capture.ts"

let passed = 0
let failed = 0
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log("  ok  " + name) }
  catch (e) { failed++; console.log("FAIL " + name + ": " + (e instanceof Error ? e.message : String(e))) }
}

console.log("\n== IDs & normalization ==")
check("statementHash stable", () => {
  assert.equal(statementHash("Run   migrations"), statementHash("run migrations"))
  assert.notEqual(statementHash("a"), statementHash("b"))
})
check("eventId deterministic + revision", () => {
  const a = eventId("inst", "s1", "tool.after", "p1", 0)
  const b = eventId("inst", "s1", "tool.after", "p1", 0)
  const c = eventId("inst", "s1", "tool.after", "p1", 1)
  assert.equal(a, b); assert.notEqual(a, c)
})
check("memoryId format", () => {
  const id = memoryId(); assert.ok(id.startsWith("mem_")); assert.ok(id.length > 10)
})

console.log("\n== Scope ==")
const repoScope: MemoryScope = { userId: "u", repositoryId: "r", branch: "main" }
const sessionScope: MemoryScope = { userId: "u", repositoryId: "r", branch: "main", sessionId: "s1" }
check("scopeKey hierarchical", () => {
  assert.ok(scopeKey(sessionScope).length > scopeKey(repoScope).length)
})
check("scopeCompatible broader visible", () => {
  assert.ok(scopeCompatible(sessionScope, repoScope))
})
check("scopeCompatible branch mismatch invisible", () => {
  assert.ok(!scopeCompatible({ ...repoScope, branch: "main" }, { ...repoScope, branch: "dev" }))
})
check("scopeMultiplier narrowest > broadest", () => {
  const mSession = scopeMultiplier(sessionScope, sessionScope)
  const mRepo = scopeMultiplier(sessionScope, repoScope)
  assert.ok(mSession > mRepo)
  assert.equal(scopeMultiplier(sessionScope, { ...repoScope, branch: "dev" }), 0)
})
check("scopeDepth", () => {
  assert.equal(scopeDepth({}), 0)
  assert.ok(scopeDepth(repoScope) < scopeDepth(sessionScope))
})

console.log("\n== Lifecycle ==")
check("canTransition pending->approved", () => assert.ok(canTransition("pending", "approved")))
check("cannot superseded->approved", () => assert.ok(!canTransition("superseded", "approved")))
check("can observational->approved", () => assert.ok(canTransition("observational", "approved")))

console.log("\n== Ranking ==")
check("approved ranks above challenged above pending", () => {
  const base = { confidence: 0.9, evidence: [{ eventId: "e" }], createdAt: new Date().toISOString() }
  const w = defaultRankingWeights()
  const app = rankResult(0.9, { ...base, status: "approved" as const, trustLevel: "reviewer_approved" as const, validFrom: undefined, validUntil: undefined }, sessionScope, sessionScope, false, w)
  const chal = rankResult(0.9, { ...base, status: "challenged" as const, trustLevel: "reviewer_approved" as const, validFrom: undefined, validUntil: undefined }, sessionScope, sessionScope, false, w)
  const pend = rankResult(0.9, { ...base, status: "pending" as const, trustLevel: "agent_proposed" as const, validFrom: undefined, validUntil: undefined }, sessionScope, sessionScope, false, w)
  assert.ok(app > chal && chal > pend, `${app} ${chal} ${pend}`)
})
check("expired scores 0", () => {
  const s = rankResult(0.9, { status: "approved", trustLevel: "reviewer_approved", confidence: 0.9, evidence: [{ eventId: "e" }], createdAt: new Date().toISOString(), validFrom: undefined, validUntil: "2000-01-01" }, sessionScope, sessionScope, false)
  assert.equal(s, 0)
})
check("open conflict penalizes", () => {
  const base = { status: "approved" as const, trustLevel: "reviewer_approved" as const, confidence: 0.9, evidence: [{ eventId: "e" }], createdAt: new Date().toISOString(), validFrom: undefined, validUntil: undefined }
  const noConf = rankResult(0.9, base, sessionScope, sessionScope, false)
  const conf = rankResult(0.9, base, sessionScope, sessionScope, true)
  assert.ok(conf < noConf)
})
check("evidenceMultiplier saturates", () => {
  assert.ok(evidenceMultiplier(0) < evidenceMultiplier(5))
  assert.ok(evidenceMultiplier(5) <= 1.0)
})

console.log("\n== Validation ==")
check("valid propose passes", () => {
  assert.equal(validatePropose({ kind: "decision", statement: "use postgres", scope: repoScope, confidence: 0.9, durability: "long_term" }).length, 0)
})
check("invalid kind rejected", () => {
  assert.ok(validatePropose({ kind: "x" as never, statement: "s", scope: repoScope, confidence: 0.5, durability: "long_term" }).length > 0)
})
check("empty scope rejected", () => {
  assert.ok(validatePropose({ kind: "fact", statement: "s", scope: {}, confidence: 0.5, durability: "long_term" }).length > 0)
})
check("candidate without evidence rejected", () => {
  const c: ExtractedCandidate = { kind: "fact", statement: "s", scope: repoScope, evidenceEventIds: [], confidence: 0.9, durability: "session", importance: "low", reviewRecommendation: "auto_observational", rationale: "r" }
  assert.ok(validateCandidate(c, new Set()).length > 0)
})
check("candidate with unknown evidence rejected", () => {
  const c: ExtractedCandidate = { kind: "fact", statement: "s", scope: repoScope, evidenceEventIds: ["evt_missing"], confidence: 0.9, durability: "session", importance: "low", reviewRecommendation: "auto_observational", rationale: "r" }
  assert.ok(validateCandidate(c, new Set(["evt_other"])).length > 0)
})
check("isExpired / indexEligible", () => {
  assert.ok(isExpired({ status: "expired", validUntil: undefined } as never))
  assert.ok(isExpired({ status: "approved", validUntil: "2000-01-01" } as never))
  assert.ok(indexEligible({ status: "approved" } as never))
  assert.ok(!indexEligible({ status: "rejected" } as never))
})

console.log("\n== Redaction ==")
check("redacts api key value", () => {
  const r = redactPayload({ command: "export API_KEY=sk-abc123def456ghi789jkl012mno345pqr" })
  assert.ok(r.result.applied)
  assert.ok(!JSON.stringify(r.payload).includes("sk-abc123def456ghi789jkl012mno345pqr"))
})
check("redacts key-named fields", () => {
  const r = redactPayload({ token: "abc123", password: "hunter2", config: { apiKey: "x" } })
  assert.ok(r.result.applied)
  assert.equal((r.payload as { token: string }).token, "[REDACTED]")
})
check("redacts env path", () => {
  const r = redactPayload({ file: "./.env" })
  assert.ok(r.result.applied)
})
check("containsSecret detects jwt + pem", () => {
  assert.ok(containsSecret("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456"))
  assert.ok(containsSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAI\n-----END RSA PRIVATE KEY-----"))
  assert.ok(!containsSecret("hello world"))
})
check("classifySensitivity restricted for secrets", () => {
  assert.equal(classifySensitivity({ token: "sk-abc123def456ghi789jkl012mno345pqr678stu901" }), "restricted")
  assert.equal(classifySensitivity({ msg: "hi" }), "internal")
})
check("capturePolicy: extractor origin not extraction-eligible", () => {
  const p = capturePolicyFor("tool.after", "memory_extractor", "internal")
  assert.equal(p.extractionEligible, false)
  assert.equal(p.memoryCapture, true)
})
check("capturePolicy: restricted not captured", () => {
  const p = capturePolicyFor("message.user", "interactive_agent", "restricted")
  assert.equal(p.memoryCapture, false)
})

console.log("\n== Config ==")
check("default config local backend, no key", () => {
  delete process.env.SUPERMEMORY_API_KEY
  const c = loadConfig()
  assert.equal(c.backend.type, "local")
  assert.ok(c.enabled)
})
check("supermemory backend when key present", () => {
  process.env.SUPERMEMORY_API_KEY = "sm_test_key"
  const c = loadConfig()
  assert.equal(c.backend.type, "supermemory")
  delete process.env.SUPERMEMORY_API_KEY
})
check("disabled via env", () => {
  process.env.OPENCODE_MEMORY_DISABLED = "1"
  const c = loadConfig()
  assert.equal(c.enabled, false)
  delete process.env.OPENCODE_MEMORY_DISABLED
})

console.log("\n== Capture mapping ==")
const ctx: CaptureCtx = { instanceId: "inst", projectId: "p1", gitCtx: { branch: "main", commit: "abc", remote: "git@github.com:o/r.git" } }
check("captures session.created", () => {
  const ev = captureFromEvent({ type: "session.created", properties: { info: { id: "s1", title: "t" } } } as never, ctx)
  assert.ok(ev); assert.equal(ev!.type, "session.started"); assert.equal(ev!.sessionId, "s1")
})
check("captures tool.after completed", () => {
  const ev = captureFromEvent({ type: "message.part.updated", properties: { part: { id: "p1", type: "tool", sessionID: "s1", tool: "bash", state: { status: "completed", output: "done", time: { start: 1, end: 2 } } } } } as never, ctx)
  assert.ok(ev); assert.equal(ev!.type, "tool.after")
})
check("skips tool running state", () => {
  const ev = captureFromEvent({ type: "message.part.updated", properties: { part: { id: "p1", type: "tool", sessionID: "s1", tool: "bash", state: { status: "running" } } } } as never, ctx)
  assert.equal(ev, null)
})
check("captures file.edited via fallback session", () => {
  // file.edited carries no sessionID; use fallback.
  const ev = captureFromEvent({ type: "file.edited", properties: { file: "src/x.ts" } } as never, ctx, "s1")
  assert.ok(ev); assert.equal(ev!.type, "file.changed"); assert.equal(ev!.sessionId, "s1")
})
check("file.edited without fallback returns null", () => {
  const ev = captureFromEvent({ type: "file.edited", properties: { file: "src/x.ts" } } as never, ctx)
  assert.equal(ev, null)
})
check("captures permission.updated/replied", () => {
  const a = captureFromEvent({ type: "permission.updated", properties: { id: "perm1", type: "bash", title: "run x", sessionID: "s1" } } as never, ctx)
  const b = captureFromEvent({ type: "permission.replied", properties: { sessionID: "s1", permissionID: "perm1", response: "allow" } } as never, ctx)
  assert.equal(a!.type, "permission.requested"); assert.equal(b!.type, "permission.resolved")
})
check("skips no-session events", () => {
  const ev = captureFromEvent({ type: "server.connected", properties: {} } as never, ctx)
  assert.equal(ev, null)
})
check("isGitCommitCommand", () => {
  assert.ok(isGitCommitCommand("git commit -m foo"))
  assert.ok(!isGitCommitCommand("git status"))
})
check("redaction applied in capture payload", () => {
  const ev = captureFromEvent({ type: "message.part.updated", properties: { part: { id: "p1", type: "tool", sessionID: "s1", tool: "bash", state: { status: "completed", output: "sk-abc123def456ghi789jkl012mno345", time: {} } } } } as never, ctx)
  assert.ok(ev); assert.ok(!JSON.stringify(ev!.payload).includes("sk-abc123def456ghi789jkl012mno345"))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
