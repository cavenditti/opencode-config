/**
 * plugin/memory/worker.ts — asynchronous evidence → candidate processing.
 *
 * Consumes pending evidence events in batches, coalesces noise, invokes the
 * low-cost extraction model, validates structured output against the journal,
 * deduplicates, creates pending candidates (or bounded observational
 * memories), and maintains session capsules. Never blocks the plugin event
 * hook: runs on its own timer and on explicit triggers (idle/compaction/
 * commit/checkpoint).
 *
 * Recursion prevention: extractor-originated events are not eligible for
 * extraction (capture policy in redaction.ts).
 */
import type { MemoryConfig } from "./config.ts"
import type { Databases } from "./db.ts"
import type { Journal, EventRow } from "./journal.ts"
import type { MemoryStore } from "./store.ts"
import type { MemoryGateway } from "./gateway.ts"
import type { MemoryBackend } from "./backend.ts"
import {
  extractFromBatch, type ExtractionContext,
} from "./extraction.ts"
import {
  type MemoryRecord, type EvidenceEventType, type MemoryScope,
  type ExtractedCandidate, type ExtractedContradiction, type SessionCapsule, type MemoryConflict,
  type ActorReference, type EvidenceReference, type MemorySource,
  capsuleId, conflictId, statementHash,
} from "./domain.ts"
import { containsSecret } from "./redaction.ts"

interface PendingSession {
  sessionId: string
  count: number
  lastEligibleAt: string | null
  scope?: MemoryScope
}

export class MemoryWorker {
  private running = false
  private inflight = new Set<string>()
  constructor(
    private config: MemoryConfig,
    private dbs: Databases,
    private store: MemoryStore,
    private journal: Journal,
    private gateway: MemoryGateway,
    private backend: MemoryBackend,
    private resolveScope: (sessionId: string, directory?: string) => Promise<MemoryScope>,
    private scopes: Map<string, MemoryScope> = new Map(),
  ) {}

  start(intervalSeconds?: number): ReturnType<typeof setInterval> {
    const interval = (intervalSeconds ?? this.config.batching.pollIntervalSeconds) * 1000
    return setInterval(() => { void this.tick().catch(() => {}) }, interval)
  }

  /** Explicit trigger from the plugin (idle/compaction/commit/checkpoint). */
  async trigger(sessionId: string, reason: string, directory?: string): Promise<void> {
    if (this.inflight.has(sessionId)) return
    this.inflight.add(sessionId)
    try {
      await this.processSession(sessionId, reason, directory)
    } finally {
      this.inflight.delete(sessionId)
    }
  }

  async tick(): Promise<{ processed: number; sessions: number }> {
    if (this.running) return { processed: 0, sessions: 0 }
    this.running = true
    try {
      const sessions = this.dueSessions()
      let processed = 0
      for (const s of sessions) {
        if (this.inflight.has(s.sessionId)) continue
        this.inflight.add(s.sessionId)
        try {
          processed += await this.processSession(s.sessionId, "scheduled")
        } finally {
          this.inflight.delete(s.sessionId)
        }
      }
      return { processed, sessions: sessions.length }
    } finally {
      this.running = false
    }
  }

  private dueSessions(): PendingSession[] {
    const rows = this.dbs.journal.prepare(
      `SELECT session_id, COUNT(*) AS cnt, MAX(last_eligible_at) AS last
       FROM events
       WHERE processing_status = 'pending'
       GROUP BY session_id`,
    ).all() as { session_id: string; cnt: number; last: string | null }[]
    const now = Date.now()
    const out: PendingSession[] = []
    for (const r of rows) {
      const lastAgeMs = r.last ? now - Date.parse(r.last) : Infinity
      const due =
        r.cnt >= this.config.batching.maxEvents ||
        lastAgeMs >= this.config.batching.maxDelaySeconds * 1000
      if (!due) continue
      out.push({
        sessionId: r.session_id,
        count: r.cnt,
        lastEligibleAt: r.last,
        scope: this.scopes.get(r.session_id),
      })
    }
    return out
  }

  setSessionScope(sessionId: string, scope: MemoryScope): void {
    this.scopes.set(sessionId, scope)
  }

  private async processSession(sessionId: string, trigger: string, directory?: string): Promise<number> {
    let scope = this.scopes.get(sessionId)
    if (!scope) {
      scope = await this.resolveScope(sessionId, directory)
      this.scopes.set(sessionId, scope)
    }
    const claim = this.journal.claimBatch(sessionId, trigger, this.config.batching.maxEvents)
    if (!claim || claim.events.length === 0) return 0

    const eventIds = new Set(claim.events.map((e) => e.id))
    const coalesced = coalesce(claim.events)
    const existingRelated = this.findRelated(scope, coalesced)
    const capsule = this.store.listCapsules(sessionId)[0] ?? undefined
    const ctx: ExtractionContext = {
      sessionScope: scope,
      existingRelated,
      capsule,
    }

    let result
    try {
      result = await extractFromBatch(coalesced, ctx, this.store, this.config)
    } catch (error) {
      this.journal.markBatch(claim.batchId, "failed", error instanceof Error ? error.message : String(error), 0)
      this.journal.settleEvents(claim.events.map((e) => e.id), false)
      return 0
    }

    // Persist capsule patch.
    if (result.capsulePatch) {
      this.upsertCapsule(sessionId, scope, result.capsulePatch, capsule)
    }

    // Validate + ingest candidates.
    let candidateCount = 0
    for (let i = 0; i < result.candidates.length; i++) {
      const cand = result.candidates[i]
      const issues = this.validateCandidateAgainstJournal(cand, eventIds)
      if (issues.length) continue
      const source: MemorySource = {
        type: "memory.explicit",
        origin: "memory_extractor",
        actor: { kind: "extractor", id: "memory-worker", model: this.config.extraction.model },
        extractorModel: this.config.extraction.model,
      }
      try {
        const res = await this.gateway.ingestCandidate(cand, source, scope)
        candidateCount++
        // Apply contradictions referencing this candidate.
        for (const c of result.contradictions) {
          if (c.candidateIndex === i) {
            this.recordContradiction(res.memoryId, c, scope)
          }
        }
      } catch {
        // skip invalid candidate
      }
    }

    // Mark events processed.
    this.journal.markBatch(claim.batchId, "completed", null, candidateCount)
    this.journal.settleEvents(claim.events.map((e) => e.id), true)
    return candidateCount
  }

  private validateCandidateAgainstJournal(cand: ExtractedCandidate, knownEventIds: Set<string>): string[] {
    const issues: string[] = []
    if (!cand.evidenceEventIds.length) issues.push("no evidence")
    for (const id of cand.evidenceEventIds) {
      if (!knownEventIds.has(id)) issues.push(`unknown event id ${id}`)
    }
    if (containsSecret(cand.statement)) issues.push("statement contains a secret")
    if (cand.confidence < 0 || cand.confidence > 1) issues.push("confidence out of range")
    if (!cand.statement.trim()) issues.push("empty statement")
    if (cand.statement.length > 4000) issues.push("statement too long")
    return issues
  }

  private recordContradiction(candidateId: string, c: ExtractedContradiction, scope: MemoryScope): void {
    const conflict: MemoryConflict = {
      id: conflictId(),
      memoryIds: [candidateId],
      candidateIds: [candidateId],
      conflictType: c.conflictType,
      status: "open",
      evidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.store.createConflict(conflict)
  }

  private findRelated(scope: MemoryScope, events: EventRow[]): { id: string; statement: string; statementHash: string }[] {
    const out: { id: string; statement: string; statementHash: string }[] = []
    // Use statement hashes from tool/file events to find related approved memories.
    for (const e of events.slice(0, 8)) {
      const local = this.store.ftsSearch(e.summary.slice(0, 120), 3)
      for (const { record } of local) {
        if (!out.find((r) => r.id === record.id)) {
          out.push({ id: record.id, statement: record.statement, statementHash: statementHash(record.statement) })
        }
      }
    }
    return out.slice(0, 20)
  }

  private upsertCapsule(sessionId: string, scope: MemoryScope, patch: Partial<SessionCapsule>, existing?: SessionCapsule): void {
    const now = new Date().toISOString()
    const base: SessionCapsule = existing ?? {
      id: capsuleId(),
      sessionId,
      scope,
      objective: patch.objective ?? "ongoing session",
      outcome: "ongoing",
      userRequirements: [],
      decisions: [],
      discoveries: [],
      filesChanged: [],
      commandsOfInterest: [],
      failures: [],
      resolutions: [],
      unresolvedQuestions: [],
      nextActions: [],
      evidenceEventIds: [],
      source: "memory_extractor",
      createdAt: now,
    }
    const merged: SessionCapsule = {
      ...base,
      objective: patch.objective ?? base.objective,
      outcome: patch.outcome ?? base.outcome,
      userRequirements: dedupe([...base.userRequirements, ...(patch.userRequirements ?? [])]),
      decisions: dedupe([...base.decisions, ...(patch.decisions ?? [])]),
      discoveries: dedupe([...base.discoveries, ...(patch.discoveries ?? [])]),
      failures: [...base.failures, ...(patch.failures ?? [])],
      resolutions: [...base.resolutions, ...(patch.resolutions ?? [])],
      unresolvedQuestions: dedupe([...base.unresolvedQuestions, ...(patch.unresolvedQuestions ?? [])]),
      nextActions: dedupe([...base.nextActions, ...(patch.nextActions ?? [])]),
    }
    if (existing) {
      // Replace by deleting + recreating (capsules are append-only summaries).
      this.dbs.store.prepare("DELETE FROM capsules WHERE id = ?").run(existing.id)
    }
    this.store.createCapsule(merged)
  }
}

function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const v of arr) {
    const key = typeof v === "string" ? v : JSON.stringify(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/** Coalesce noise before extraction. Deterministic, local. */
export function coalesce(events: EventRow[]): EventRow[] {
  const out: EventRow[] = []
  const seenError = new Map<string, number>()
  for (const e of events) {
    // Drop repeated identical errors (keep first + count).
    if (e.event_type === "tool.error" || e.event_type === "session.failed") {
      const key = (e.payload as { error?: string } | null)?.error ?? e.summary
      if (seenError.has(key)) {
        seenError.set(key, (seenError.get(key) ?? 0) + 1)
        continue
      }
      seenError.set(key, 1)
    }
    // Drop low-value successful reads.
    if (e.event_type === "file.read" && e.summary.includes("size=0")) continue
    // Collapse repeated build commands.
    if (e.event_type === "command.executed") {
      const cmd = (e.payload as { command?: string } | null)?.command
      if (cmd && /^(npm|pnpm|yarn|tsc|cargo|make)\s+(run|build|test|tsc)/.test(cmd)) {
        if (out.some((o) => o.event_type === "command.executed" && (o.payload as { command?: string } | null)?.command === cmd)) continue
      }
    }
    out.push(e)
  }
  return out
}
