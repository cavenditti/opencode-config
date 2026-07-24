/**
 * plugin/memory/gateway.ts — the backend-independent memory contract.
 *
 * Owns: validation, scope rules, state transitions, provenance, dedup,
 * contradiction surfacing, trust-aware ranking, token-budget context
 * assembly, and review workflow. Models receive compact, ranked, qualified
 * bundles — never raw backend search responses.
 *
 * "Agents propose; governance decides."
 */
import type { MemoryConfig } from "./config.ts"
import type { Databases } from "./db.ts"
import type { Journal, EventRow } from "./journal.ts"
import type { MemoryStore } from "./store.ts"
import type { BackendRegistry, BackendRecordReference } from "./backend.ts"
import {
  indexWithFallback,
  type BackendSearchQuery, type BackendSearchResult,
} from "./backend.ts"
import {
  type MemoryScope, type MemoryRecord, type EvidenceReference, type ActorReference,
  type MemoryKind, type TrustLevel, type MemoryStatus, type Durability,
  type MemoryContextBundle, type MemoryContextItem, type MemoryConflictSummary,
  type MemoryReview, type MemoryConflict, type EvidenceEventType, type RelationKind,
  type ExtractedCandidate, type SessionCapsuleSummary, type MemorySource,
  type EvidenceEvent, type SessionCapsule,
  reviewId, conflictId, statementHash, normalizeStatement,
  validatePropose, validateCandidate, scopeCompatible,
  rankResult, defaultRankingWeights, isExpired, indexEligible, scopeDepth,
} from "./domain.ts"
import { buildMemoryRecord } from "./store.ts"
import { captureGitState, repositoryId } from "./git.ts"

export interface ProposeInput {
  kind: MemoryKind
  statement: string
  structuredPayload?: Record<string, unknown>
  scope: Partial<MemoryScope>
  evidence?: EvidenceReference[]
  confidence: number
  durability: Durability
  validFrom?: string
  validUntil?: string
  tags?: string[]
  reason?: string
}

export interface ReviewInput {
  memoryId: string
  decision: MemoryReview["decision"]
  rationale: string
  editedStatement?: string
  editedPayload?: Record<string, unknown>
  editedScope?: Partial<MemoryScope>
  duplicateOf?: string
  supersededByMemoryId?: string
  escalateTo?: "human" | "agent"
}

export interface ChallengeInput {
  memoryId: string
  challengeType: "incorrect" | "outdated" | "scope_too_broad" | "ambiguous" | "contradicted" | "unsupported"
  explanation: string
  evidence?: EvidenceReference[]
  proposedReplacement?: ProposeInput
}

export interface CheckpointInput {
  reason: "task_completed" | "decision_reached" | "before_handoff" | "before_compaction" | "manual"
  summary?: string
  importantEventIds?: string[]
}

export interface ProposeResult {
  memoryId: string
  status: MemoryStatus
  trustLevel: TrustLevel
  duplicateOf?: string
  autoAccepted: boolean
  reason: string
}

export class MemoryGateway {
  constructor(
    private config: MemoryConfig,
    private dbs: Databases,
    private store: MemoryStore,
    private journal: Journal,
    private registry: BackendRegistry,
  ) {}

  // ── Scope resolution ──────────────────────────────────────────────────────

  async resolveScope(input: {
    directory?: string
    worktree?: string
    sessionId?: string
    userId?: string
    agent?: string
  }): Promise<MemoryScope> {
    const scope: MemoryScope = {
      userId: input.userId ?? process.env.USER ?? "default",
      sessionId: input.sessionId,
    }
    const dir = input.worktree ?? input.directory ?? process.cwd()
    const git = await captureGitState(dir)
    if (git) {
      scope.repositoryId = repositoryId(git)
      scope.repositoryRemote = git.remote
      scope.branch = git.branch
      scope.commitFrom = git.commit
      if (input.worktree && git.root && input.worktree !== git.root) {
        scope.worktreeId = input.worktree
      }
    }
    scope.projectId = input.worktree ?? dir
    return scope
  }

  // ── Explicit propose ──────────────────────────────────────────────────────

  async propose(input: ProposeInput, actor: ActorReference, scope: MemoryScope): Promise<ProposeResult> {
    const issues = validatePropose(input)
    if (issues.length) {
      throw new Error(`invalid propose: ${issues.map((i) => i.field + ": " + i.message).join("; ")}`)
    }
    const hash = statementHash(input.statement)
    const existing = this.store.byStatementHash(hash)
    const scopeResolved = { ...scope, ...input.scope } as MemoryScope

    // Duplicate detection: exact hash within a compatible scope.
    for (const mem of existing) {
      if (mem.status === "rejected" || mem.status === "superseded") continue
      if (scopeCompatible(scopeResolved, mem.scope) && normalizeStatement(mem.statement) === normalizeStatement(input.statement)) {
        return {
          memoryId: mem.id,
          status: mem.status,
          trustLevel: mem.trustLevel,
          duplicateOf: mem.id,
          autoAccepted: false,
          reason: `duplicate of existing ${mem.status} memory ${mem.id}`,
        }
      }
    }

    const source: MemorySource = {
      type: "explicit",
      origin: actor.kind === "reviewer" ? "memory_reviewer" : "interactive_agent",
      actor,
    }
    const trustLevel: TrustLevel =
      actor.kind === "user" ? "user_asserted" :
      actor.kind === "reviewer" ? "reviewer_approved" :
      "agent_proposed"

    let record = buildMemoryRecord({
      kind: input.kind,
      statement: input.statement,
      scope: scopeResolved,
      source,
      evidence: input.evidence ?? [],
      confidence: input.confidence,
      trustLevel,
      durability: input.durability,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      tags: input.tags ?? [],
      createdBy: actor,
    })

    // Auto-accept policy.
    const decision = this.autoAcceptDecision(record, input.reason)
    if (decision.accept) {
      record = { ...record, status: decision.status ?? "approved", trustLevel: decision.trustLevel ?? trustLevel }
    }
    this.store.create(record)

    // Index asynchronously, best-effort.
    void this.indexMemory(record)

    return {
      memoryId: record.id,
      status: record.status,
      trustLevel: record.trustLevel,
      autoAccepted: decision.accept,
      reason: decision.reason,
    }
  }

  private autoAcceptDecision(record: MemoryRecord, reason?: string): { accept: boolean; status?: MemoryStatus; trustLevel?: TrustLevel; reason: string } {
    const c = this.config.review
    // Observational: bounded facts about a specific event.
    if (c.autoAcceptObservations && this.isObservational(record)) {
      return { accept: true, status: "observational", reason: "auto-accepted as observational" }
    }
    // User-asserted requirements.
    if (c.autoAcceptUserRequirements && record.kind === "requirement" && record.trustLevel === "user_asserted" && scopeDepth(record.scope) > 1) {
      return { accept: true, status: "approved", reason: "auto-accepted user requirement" }
    }
    // Repository-verified deterministic facts.
    if (c.autoAcceptRepositoryFacts && record.trustLevel === "repository_verified") {
      return { accept: true, status: "approved", reason: "auto-accepted repository-verified fact" }
    }
    // Global user preferences require human review.
    if (c.requireHumanForGlobalPreferences && record.kind === "preference" && scopeDepth(record.scope) <= 1) {
      return { accept: false, reason: "global preference requires human review" }
    }
    return { accept: false, reason: "pending agent/human review" }
  }

  private isObservational(record: MemoryRecord): boolean {
    return (
      record.kind === "fact" &&
      record.durability !== "long_term" &&
      (record.evidence.some((e) => e.eventId) || record.source.origin === "system")
    )
  }

  // ── Relate ──────────────────────────────────────────────────────────────

  async relate(subjectId: string, predicate: RelationKind, objectId: string, evidence: EvidenceReference[], confidence: number, actor: ActorReference): Promise<{ id: string }> {
    const id = "rel_" + subjectId.slice(4, 12) + "_" + objectId.slice(4, 12) + "_" + predicate
    this.store.upsertRelation(id, subjectId, predicate, objectId, evidence, confidence)
    return { id }
  }

  // ── Challenge ─────────────────────────────────────────────────────────────

  async challenge(input: ChallengeInput, actor: ActorReference, scope: MemoryScope): Promise<{ challengeMemoryId?: string; conflictId: string }> {
    const target = this.store.get(input.memoryId)
    if (!target) throw new Error(`memory not found: ${input.memoryId}`)
    // Mark target challenged (does not delete).
    if (target.status === "approved" || target.status === "observational" || target.status === "pending") {
      this.store.update(input.memoryId, { status: "challenged" })
      // Re-index with challenged status.
      const updated = this.store.get(input.memoryId)!
      void this.indexMemory(updated)
    }
    let challengeMemoryId: string | undefined
    if (input.proposedReplacement) {
      const result = await this.propose(input.proposedReplacement, actor, scope)
      challengeMemoryId = result.memoryId
    }
    const conflict: MemoryConflict = {
      id: conflictId(),
      memoryIds: challengeMemoryId ? [input.memoryId, challengeMemoryId] : [input.memoryId],
      candidateIds: challengeMemoryId ? [challengeMemoryId] : [],
      conflictType: this.mapChallengeType(input.challengeType),
      status: "open",
      evidence: input.evidence ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.store.createConflict(conflict)
    return { challengeMemoryId, conflictId: conflict.id }
  }

  private mapChallengeType(t: ChallengeInput["challengeType"]): MemoryConflict["conflictType"] {
    switch (t) {
      case "incorrect": return "direct_contradiction"
      case "outdated": return "temporal_change"
      case "scope_too_broad": return "scope_mismatch"
      case "ambiguous": return "ambiguous"
      case "contradicted": return "direct_contradiction"
      case "unsupported": return "source_disagreement"
    }
  }

  // ── Checkpoint ─────────────────────────────────────────────────────────────

  async checkpoint(input: CheckpointInput, sessionId: string, actor: ActorReference): Promise<{ enqueued: boolean }> {
    // Enqueue a priority extraction batch by creating a synthetic event.
    const seq = this.journal.nextSequence(sessionId)
    const event: EvidenceEvent = {
      id: "evt_cp_" + sessionId + "_" + seq,
      schemaVersion: 1,
      instanceId: this.config.instanceId,
      sessionId,
      sequence: seq,
      type: "checkpoint.requested" as EvidenceEventType,
      timestamp: new Date().toISOString(),
      actor,
      origin: "interactive_agent",
      summary: input.summary ?? `checkpoint: ${input.reason}`,
      payload: { reason: input.reason, summary: input.summary, importantEventIds: input.importantEventIds },
      sensitivity: "internal",
      redaction: { applied: false, fieldCount: 0, patterns: [] },
      capturePolicy: { memoryCapture: true, extractionEligible: true, retentionClass: "permanent" },
    }
    this.journal.append(event)
    this.journal.touchEligible(sessionId)
    return { enqueued: true }
  }

  // ── Search & context ──────────────────────────────────────────────────────

  async search(query: string, scope: MemoryScope, opts: {
    kinds?: MemoryKind[]
    statuses?: MemoryStatus[]
    includePending?: boolean
    limit?: number
    tokenBudget?: number
  } = {}): Promise<MemoryContextBundle> {
    return this.assemble(query, scope, opts)
  }

  async context(query: string, scope: MemoryScope, opts: {
    kinds?: MemoryKind[]
    includePending?: boolean
    maxItems?: number
    tokenBudget?: number
  } = {}): Promise<MemoryContextBundle> {
    return this.assemble(query, scope, {
      kinds: opts.kinds,
      includePending: opts.includePending ?? this.config.retrieval.includePending,
      limit: opts.maxItems ?? this.config.retrieval.defaultLimit,
      tokenBudget: opts.tokenBudget ?? this.config.retrieval.defaultTokenBudget,
    })
  }

  async get(memoryId_: string, opts: { includeEvidence?: boolean; includeHistory?: boolean } = {}): Promise<{
    record: MemoryRecord
    evidence: EventRow[]
    reviews: MemoryReview[]
    conflicts: MemoryConflict[]
  } | null> {
    const record = this.store.get(memoryId_)
    if (!record) return null
    const evidenceIds = opts.includeEvidence !== false ? record.evidence.map((e) => e.eventId).filter((x): x is string => !!x) : []
    const evidence = evidenceIds.length ? this.journal.getMany(evidenceIds) : []
    const reviews = opts.includeHistory !== false ? this.store.reviewsFor(memoryId_) : []
    const conflicts = this.store.openConflictsFor([memoryId_])
    return { record, evidence, reviews, conflicts }
  }

  private async assemble(query: string, scope: MemoryScope, opts: {
    kinds?: MemoryKind[]
    statuses?: MemoryStatus[]
    includePending?: boolean
    limit?: number
    tokenBudget?: number
  }): Promise<MemoryContextBundle> {
    const limit = opts.limit ?? this.config.retrieval.defaultLimit
    const tokenBudget = opts.tokenBudget ?? this.config.retrieval.defaultTokenBudget
    const includePending = opts.includePending ?? false

    const backendQuery: BackendSearchQuery = {
      query,
      scopes: [scope],
      limit: limit * 2,
      threshold: this.config.retrieval.semanticThreshold,
      includePending,
      kinds: opts.kinds,
    }

    let results: BackendSearchResult[] = []
    try {
      results = await this.registry.primary.search(backendQuery)
    } catch {
      results = await this.registry.fallback.search(backendQuery)
    }
    if (results.length === 0 && this.registry.type !== "local") {
      results = await this.registry.fallback.search(backendQuery)
    }

    const ids = results.map((r) => r.memoryId)
    const scores = new Map(results.map((r) => [r.memoryId, r.score]))
    let records = this.store.getMany(ids)
    // If backend underperformed, supplement with local FTS (handles pending/excluded).
    if (records.length < limit) {
      const local = this.store.ftsSearch(query, limit * 2)
      for (const { record } of local) {
        if (!records.find((r) => r.id === record.id)) {
          records.push(record)
          if (!scores.has(record.id)) scores.set(record.id, 0.5)
        }
      }
    }

    const weights = defaultRankingWeights()
    const items: MemoryContextItem[] = []
    const seen = new Set<string>()
    for (const record of records) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      // Status/status filters.
      if (opts.statuses && opts.statuses.length && !opts.statuses.includes(record.status)) continue
      if (!includePending && record.status === "pending") continue
      if (record.status === "rejected" || record.status === "superseded" || record.status === "expired") continue
      if (isExpired(record)) continue
      // Scope compatibility.
      if (!scopeCompatible(scope, record.scope)) continue
      if (opts.kinds && opts.kinds.length && !opts.kinds.includes(record.kind)) continue
      const conflicts = this.store.openConflictsFor([record.id])
      const score = rankResult(
        scores.get(record.id) ?? 0.5,
        record,
        scope,
        record.scope,
        conflicts.length > 0,
        weights,
      )
      if (score <= 0) continue
      items.push({
        memoryId: record.id,
        kind: record.kind,
        status: record.status,
        statement: record.statement,
        trustLevel: record.trustLevel,
        confidence: record.confidence,
        scope: record.scope,
        score,
        evidenceCount: record.evidence.length,
        tags: record.tags,
        validFrom: record.validFrom,
        validUntil: record.validUntil,
        createdAt: record.createdAt,
        sourceType: record.source.type,
      })
    }

    items.sort((a, b) => b.score - a.score)

    // Token budget trimming.
    const truncated = trimToTokenBudget(items, tokenBudget)
    const returned = truncated.items

    // Conflict summaries.
    const conflictIds = new Set<string>()
    const conflictSummaries: MemoryConflictSummary[] = []
    for (const item of returned) {
      for (const c of this.store.openConflictsFor([item.memoryId])) {
        if (conflictIds.has(c.id)) continue
        conflictIds.add(c.id)
        conflictSummaries.push({
          conflictId: c.id,
          conflictType: c.conflictType,
          memoryIds: c.memoryIds,
          status: c.status,
        })
      }
    }

    // Relevant episodes (capsules for this session/repo).
    const relevantEpisodes: SessionCapsuleSummary[] = []
    if (scope.sessionId) {
      for (const cap of this.store.listCapsules(scope.sessionId)) {
        relevantEpisodes.push({
          capsuleId: cap.id,
          sessionId: cap.sessionId,
          objective: cap.objective,
          outcome: cap.outcome,
          createdAt: cap.createdAt,
        })
      }
    }

    return {
      summary: returned.length ? `${returned.length} relevant memories` : "no relevant memories found",
      memories: returned,
      unresolvedContradictions: conflictSummaries,
      relevantEpisodes,
      truncated: truncated.truncated,
    }
  }

  // ── Reviewer workflow ────────────────────────────────────────────────────

  async listPending(limit: number = 50, kind?: MemoryKind): Promise<MemoryRecord[]> {
    return this.store.list({ status: "pending", kind, limit })
  }

  async listChallenged(limit: number = 50): Promise<MemoryRecord[]> {
    return this.store.list({ status: "challenged", limit })
  }

  async review(input: ReviewInput, reviewer: ActorReference): Promise<{ memoryId: string; status: MemoryStatus }> {
    const record = this.store.get(input.memoryId)
    if (!record) throw new Error(`memory not found: ${input.memoryId}`)
    const now = new Date().toISOString()
    const review: MemoryReview = {
      id: reviewId(),
      memoryId: input.memoryId,
      decision: input.decision,
      reviewer,
      rationale: input.rationale,
      editedStatement: input.editedStatement,
      editedPayload: input.editedPayload,
      editedScope: input.editedScope as MemoryScope | undefined,
      duplicateOf: input.duplicateOf,
      supersededByMemoryId: input.supersededByMemoryId,
      escalateTo: input.escalateTo,
      createdAt: now,
    }
    this.store.createReview(review)

    let newStatus: MemoryStatus = record.status
    let patch: Partial<MemoryRecord> = { reviewedBy: reviewer, reviewId: review.id }
    switch (input.decision) {
      case "approve":
        newStatus = "approved"
        patch.trustLevel = "reviewer_approved"
        break
      case "edit_and_approve":
        newStatus = "approved"
        patch.trustLevel = "reviewer_approved"
        if (input.editedStatement) patch.statement = input.editedStatement
        if (input.editedPayload) patch.structuredPayload = input.editedPayload
        if (input.editedScope) patch.scope = { ...record.scope, ...input.editedScope }
        break
      case "reject":
        newStatus = "rejected"
        break
      case "duplicate":
        if (input.duplicateOf) {
          newStatus = "superseded"
          patch.supersededBy = input.duplicateOf
          patch.supersedes = [...record.supersedes]
        } else {
          newStatus = "rejected"
        }
        break
      case "supersede":
        newStatus = "superseded"
        if (input.supersededByMemoryId) patch.supersededBy = input.supersededByMemoryId
        break
      case "escalate":
        newStatus = record.status
        break
    }
    const updated = this.store.update(input.memoryId, { ...patch, status: newStatus })
    if (updated) void this.indexMemory(updated)
    return { memoryId: input.memoryId, status: newStatus }
  }

  async supersede(memoryId_: string, replacement: ProposeInput, reviewer: ActorReference, scope: MemoryScope): Promise<{ original: MemoryStatus; replacementId: string }> {
    const result = await this.propose(replacement, reviewer, scope)
    const updated = this.store.update(memoryId_, {
      status: "superseded",
      supersededBy: result.memoryId,
      reviewedBy: reviewer,
    })
    if (updated) void this.indexMemory(updated)
    // Remove the superseded memory from the index; the replacement is indexed on propose.
    const original = this.store.get(memoryId_)
    if (original?.backendMappings) {
      for (const m of original.backendMappings) {
        void this.registry.primary.remove(m).catch(() => {})
      }
    }
    return { original: "superseded", replacementId: result.memoryId }
  }

  async mergeDuplicates(keepId: string, dropIds: string[], reviewer: ActorReference): Promise<{ merged: number }> {
    const keep = this.store.get(keepId)
    if (!keep) throw new Error(`keep memory not found: ${keepId}`)
    for (const dropId of dropIds) {
      const drop = this.store.get(dropId)
      if (!drop) continue
      // Merge evidence into keep.
      const mergedEvidence = [...keep.evidence, ...drop.evidence]
      this.store.update(keepId, { evidence: mergedEvidence, reviewedBy: reviewer })
      this.store.update(dropId, {
        status: "superseded",
        supersededBy: keepId,
        reviewedBy: reviewer,
      })
      if (drop.backendMappings) {
        for (const m of drop.backendMappings) {
          void this.registry.primary.remove(m).catch(() => {})
        }
      }
    }
    return { merged: dropIds.length }
  }

  // ── Indexing helper ────────────────────────────────────────────────────────

  private async indexMemory(record: MemoryRecord): Promise<void> {
    if (!indexEligible(record, this.config.backend.indexPending)) return
    try {
      const ref = await indexWithFallback(this.registry, record, () => {
        this.store.setBackendMapping(record.id, [])
      })
      this.store.setBackendMapping(record.id, [{ backend: ref.backend, backendId: ref.backendId, containerTag: ref.containerTag, indexedAt: new Date().toISOString() }])
    } catch {
      this.store.setBackendMapping(record.id, [])
    }
  }

  // ── Worker-facing ingest (used by the extraction worker) ──────────────────

  async ingestCandidate(candidate: ExtractedCandidate, source: MemorySource, scope: MemoryScope): Promise<ProposeResult> {
    const issues = validateCandidate(candidate, new Set(candidate.evidenceEventIds))
    // Note: evidence event existence is checked against the journal in the worker.
    if (issues.some((i) => i.field === "statement" || i.field === "kind" || i.field === "confidence" || i.field === "durability")) {
      throw new Error(`invalid candidate: ${issues.map((i) => i.message).join("; ")}`)
    }
    return this.propose({
      kind: candidate.kind,
      statement: candidate.statement,
      structuredPayload: candidate.structuredPayload,
      scope: candidate.scope,
      evidence: candidate.evidenceEventIds.map((id) => ({ eventId: id })),
      confidence: candidate.confidence,
      durability: candidate.durability,
      validFrom: candidate.validFrom,
      validUntil: candidate.validUntil,
      reason: candidate.rationale,
    }, source.actor, { ...scope, ...candidate.scope } as MemoryScope)
  }
}

// ─── Token budgeting ────────────────────────────────────────────────────────

const APPROX_TOKENS_PER_CHAR = 0.28
const ITEM_OVERHEAD = 40

function trimToTokenBudget(items: MemoryContextItem[], budget: number): { items: MemoryContextItem[]; truncated: boolean } {
  let used = 0
  const out: MemoryContextItem[] = []
  for (const item of items) {
    const cost = ITEM_OVERHEAD + Math.ceil(item.statement.length * APPROX_TOKENS_PER_CHAR)
    if (used + cost > budget && out.length > 0) {
      return { items: out, truncated: true }
    }
    used += cost
    out.push(item)
    if (out.length >= 32) break
  }
  return { items: out, truncated: out.length < items.length }
}
