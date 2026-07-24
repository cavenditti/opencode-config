import assert from "node:assert"
import {
  normalizeStatement, statementHash, eventId, scopeKey, scopeCompatible,
  scopeMultiplier, scopeDepth, canTransition, rankResult, defaultRankingWeights,
  validatePropose, validateCandidate, isExpired, indexEligible, recencyMultiplier,
  evidenceMultiplier, actorRef, memoryId, memoryVisibleFrom, isGlobalScope, scopeContainerTag,
  type MemoryScope, type ExtractedCandidate, type MemoryRecord, type MemoryReview,
} from "./domain.ts"
import { loadConfig } from "./config.ts"
import { redactPayload, containsSecret, classifySensitivity, capturePolicyFor } from "./redaction.ts"
import { captureFromEvent, type CaptureCtx, isGitCommitCommand } from "./capture.ts"
import { buildMemoryRecord } from "./store.ts"
import { containerTagFor, indexableFrom } from "./backend.ts"
import { MemoryGateway } from "./gateway.ts"
import { extractFromBatch } from "./extraction.ts"

let passed = 0
let failed = 0
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log("  ok  " + name) }
  catch (e) { failed++; console.log("FAIL " + name + ": " + (e instanceof Error ? e.message : String(e))) }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("  ok  " + name) }
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
check("scopeCompatible rejects candidate dimensions absent from current", () => {
  assert.ok(!scopeCompatible({ userId: "u", projectId: "p" }, { userId: "u", projectId: "p", repositoryId: "r" }))
})
check("unapproved global memory is invisible", () => {
  const global = { scope: { userId: "u" }, globalApproval: undefined }
  assert.ok(isGlobalScope(global.scope))
  assert.ok(!memoryVisibleFrom(sessionScope, global))
})
check("user-approved global memory is visible", () => {
  const global = {
    scope: { userId: "u" },
    globalApproval: {
      approvedAt: new Date().toISOString(),
      approvedBy: actorRef("user", "u"),
      method: "interactive_permission" as const,
      rationale: "shared convention",
      sourceProjectId: "p",
    },
  }
  assert.ok(memoryVisibleFrom(sessionScope, global))
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
  assert.ok(indexEligible({ status: "approved", scope: { projectId: "p" } } as never))
  assert.ok(!indexEligible({ status: "approved", scope: { userId: "u" } } as never))
  assert.ok(!indexEligible({ status: "rejected", scope: { projectId: "p" } } as never))
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
  assert.equal(c.batching.maxAttempts, 3)
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

await checkAsync("deterministic fallback reports completed tools without inventing exit success", async () => {
  const config = loadConfig({ extraction: { provider: "external", externalUrl: "" } })
  const result = await extractFromBatch([{
    id: "evt_tool",
    event_type: "tool.after",
    session_id: "session1234",
    payload: { tool: "bash" },
  } as never], {
    sessionScope,
    existingRelated: [],
  }, {} as never, config)
  assert.equal(result.candidates.length, 1)
  assert.match(result.candidates[0].statement, /bash completed/)
  assert.doesNotMatch(result.candidates[0].statement, /succeeded/)
})

console.log("\n== Gateway project isolation ==")
class FakeStore {
  records = new Map<string, MemoryRecord>()
  reviews: MemoryReview[] = []
  create(record: MemoryRecord) { this.records.set(record.id, structuredClone(record)) }
  get(id: string) { return this.records.get(id) ?? null }
  getMany(ids: string[]) { return ids.map((id) => this.get(id)).filter((item): item is MemoryRecord => !!item) }
  update(id: string, patch: Partial<MemoryRecord>) {
    const current = this.get(id)
    if (!current) return null
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() }
    this.records.set(id, updated)
    return updated
  }
  byStatementHash(hash: string) { return [...this.records.values()].filter((item) => statementHash(item.statement) === hash) }
  setBackendMapping(id: string, backendMappings: MemoryRecord["backendMappings"]) { this.update(id, { backendMappings }) }
  ftsSearch(query: string, limit: number) {
    const terms = normalizeStatement(query).split(" ")
    return [...this.records.values()]
      .filter((item) => terms.some((term) => normalizeStatement(item.statement).includes(term)))
      .slice(0, limit)
      .map((record) => ({ record, rank: 1 }))
  }
  openConflictsFor() { return [] }
  reviewsFor(memoryId: string) { return this.reviews.filter((item) => item.memoryId === memoryId) }
  createReview(review: MemoryReview) { this.reviews.push(review) }
  listCapsules() { return [] }
  list(filter: { status?: string; kind?: string; limit?: number }) {
    return [...this.records.values()]
      .filter((item) => !filter.status || item.status === filter.status)
      .filter((item) => !filter.kind || item.kind === filter.kind)
      .slice(0, filter.limit)
  }
}
const fakeStore = new FakeStore()
const fakeJournal = { getMany: () => [], nextSequence: () => 1, append: () => {}, touchEligible: () => {} }
const fakeBackend = {
  index: async (record: { id: string }) => ({ backend: "local", backendId: record.id }),
  update: async (reference: { backend: string; backendId: string }) => reference,
  remove: async () => {},
  search: async () => [],
  health: async () => ({ healthy: true, backend: "local" }),
}
const gatewayConfig = loadConfig({ backend: { type: "local" }, retrieval: { semanticThreshold: 0 } })
const gateway = new MemoryGateway(gatewayConfig, {} as never, fakeStore as never, fakeJournal as never, {
  primary: fakeBackend,
  fallback: fakeBackend,
  type: "local",
} as never)
const scopeA: MemoryScope = { userId: "u", projectId: "project-a", repositoryId: "repo", branch: "main", sessionId: "sa" }
const scopeB: MemoryScope = { userId: "u", projectId: "project-b", repositoryId: "repo", branch: "main", sessionId: "sb" }
const proposer = actorRef("agent", "coder")
let projectMemoryId = ""

await checkAsync("proposal defaults to project scope and persists structured payload", async () => {
  const result = await gateway.propose({
    kind: "decision",
    statement: "Use project-local memory boundaries",
    structuredPayload: { policy: "project-first" },
    scope: {},
    confidence: 0.9,
    durability: "project",
  }, proposer, scopeA)
  projectMemoryId = result.memoryId
  const record = fakeStore.get(result.memoryId)!
  assert.equal(record.scope.projectId, "project-a")
  assert.equal(record.scope.sessionId, undefined)
  assert.equal(record.scope.branch, undefined)
  assert.deepEqual(record.structuredPayload, { policy: "project-first" })
})

await checkAsync("proposal cannot override project identity", async () => {
  await assert.rejects(() => gateway.propose({
    kind: "fact",
    statement: "Cross-project override",
    scope: { projectId: "project-b" },
    confidence: 0.8,
    durability: "project",
  }, proposer, scopeA), /cannot override current projectId/)
})

await checkAsync("same statement in another project is not deduplicated or readable by id", async () => {
  const other = await gateway.propose({
    kind: "decision",
    statement: "Use project-local memory boundaries",
    scope: {},
    confidence: 0.9,
    durability: "project",
  }, proposer, scopeB)
  assert.notEqual(other.memoryId, projectMemoryId)
  assert.equal(await gateway.getForScope(projectMemoryId, scopeB), null)
  const bundle = await gateway.context("project local memory boundaries", scopeB, { includePending: true })
  assert.ok(bundle.memories.some((item) => item.memoryId === other.memoryId))
  assert.ok(!bundle.memories.some((item) => item.memoryId === projectMemoryId))
})

await checkAsync("session durability is bounded to the current session", async () => {
  const result = await gateway.propose({
    kind: "fact",
    statement: "Session-local observation",
    scope: {},
    evidence: [{ eventId: "evt_session" }],
    confidence: 0.9,
    durability: "session",
  }, proposer, scopeA)
  const record = fakeStore.get(result.memoryId)!
  assert.equal(record.scope.sessionId, "sa")
  assert.equal(record.status, "observational")
  assert.equal(await gateway.getForScope(result.memoryId, { ...scopeA, sessionId: "other" }), null)
})

await checkAsync("secret material is rejected before canonical persistence", async () => {
  const before = fakeStore.records.size
  await assert.rejects(() => gateway.propose({
    kind: "fact",
    statement: "API key is sk-abcdefghijklmnopqrstuvwxyz123456",
    scope: {},
    confidence: 1,
    durability: "project",
  }, proposer, scopeA), /secret material/)
  assert.equal(fakeStore.records.size, before)
})

await checkAsync("extractor provenance and trust survive ingestion", async () => {
  const result = await gateway.ingestCandidate({
    kind: "fact",
    statement: "Extractor-scoped observation",
    scope: { sessionId: "sa" },
    evidenceEventIds: ["evt_extract"],
    confidence: 0.8,
    durability: "session",
    importance: "low",
    reviewRecommendation: "auto_observational",
    rationale: "Observed in tool output",
  }, {
    type: "memory.explicit",
    origin: "memory_extractor",
    actor: actorRef("extractor", "memory-worker"),
  }, scopeA)
  const record = fakeStore.get(result.memoryId)!
  assert.equal(record.source.origin, "memory_extractor")
  assert.equal(record.trustLevel, "automatically_extracted")
})

await checkAsync("legacy unapproved global records stay quarantined", async () => {
  const legacy = buildMemoryRecord({
    kind: "preference",
    statement: "Legacy global preference must not leak",
    scope: { userId: "u" },
    source: { type: "explicit", origin: "interactive_agent", actor: proposer },
    evidence: [],
    confidence: 1,
    trustLevel: "reviewer_approved",
    durability: "long_term",
    createdBy: proposer,
  })
  fakeStore.create({ ...legacy, status: "approved" })
  assert.equal(await gateway.getForScope(legacy.id, scopeA), null)
  assert.ok(!indexEligible(fakeStore.get(legacy.id)!))
})

await checkAsync("only a user actor can promote a project memory globally", async () => {
  await assert.rejects(() => gateway.promoteGlobal(projectMemoryId, scopeA, proposer, "agent attempt"), /explicit user approval/)
  const promoted = await gateway.promoteGlobal(projectMemoryId, scopeA, actorRef("user", "u"), "Applies to every project")
  assert.ok(promoted.globalApproval)
  assert.equal(promoted.scope.projectId, undefined)
  assert.ok(await gateway.getForScope(projectMemoryId, scopeB))
  assert.ok(indexEligible(promoted))
})

await checkAsync("reviewers cannot edit an approved global statement", async () => {
  const reviewCount = fakeStore.reviews.length
  await assert.rejects(() => gateway.review({
    memoryId: projectMemoryId,
    decision: "edit_and_approve",
    rationale: "attempted edit",
    editedStatement: "Changed global statement",
  }, actorRef("reviewer", "memory-reviewer"), scopeB), /editing global memory requires/)
  assert.equal(fakeStore.reviews.length, reviewCount)
})

check("backend containers separate projects from approved globals", () => {
  assert.equal(containerTagFor(gatewayConfig, scopeA), `${gatewayConfig.backend.containerTagPrefix}:${scopeContainerTag(scopeA)}`)
  assert.equal(containerTagFor(gatewayConfig, { userId: "u" }), `${gatewayConfig.backend.containerTagPrefix}:${scopeContainerTag({ userId: "u" })}`)
  assert.notEqual(scopeContainerTag(scopeA), scopeContainerTag(scopeB))
  const promoted = fakeStore.get(projectMemoryId)!
  assert.equal(indexableFrom(promoted).containerTag, undefined)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
