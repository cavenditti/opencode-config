/**
 * plugin/memory/store.ts — canonical memory lifecycle store.
 *
 * Owns MemoryRecord, MemoryReview, MemoryConflict, SessionCapsule, and
 * relation persistence. Full-text (FTS5) index for local semantic-ish
 * retrieval. The Supermemory adapter overlays semantic retrieval on top of
 * these records; this store remains the source of authoritative status and
 * provenance even when the backend is unavailable.
 */
import type { Database } from "bun:sqlite"
import type { Databases } from "./db.ts"
import type {
  MemoryRecord, MemoryReview, MemoryConflict, SessionCapsule, MemoryScope,
  MemoryStatus, MemoryKind, TrustLevel, ActorReference, EvidenceReference,
  BackendMapping, RelationKind, EvidenceEventType,
} from "./domain.ts"
import {
  memoryId, statementHash, normalizeStatement, canTransition,
} from "./domain.ts"

function parseMemories(rows: Record<string, unknown>[]): MemoryRecord[] {
  return rows.map(rowToMemory)
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    schemaVersion: row.schema_version as number,
    kind: row.kind as MemoryKind,
    status: row.status as MemoryStatus,
    statement: row.statement as string,
    structuredPayload: row.structured_payload_json ? JSON.parse(row.structured_payload_json as string) : undefined,
    scope: JSON.parse(row.scope_json as string),
    source: JSON.parse(row.source_json as string),
    evidence: JSON.parse(row.evidence_json as string),
    confidence: row.confidence as number,
    trustLevel: row.trust_level as TrustLevel,
    durability: row.durability as string as MemoryRecord["durability"],
    validFrom: (row.valid_from ?? undefined) as string | undefined,
    validUntil: (row.valid_until ?? undefined) as string | undefined,
    supersedes: JSON.parse((row.supersedes_json ?? "[]") as string),
    supersededBy: (row.superseded_by ?? undefined) as string | undefined,
    tags: JSON.parse((row.tags_json ?? "[]") as string),
    backendMappings: row.backend_mappings_json ? JSON.parse(row.backend_mappings_json as string) : undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: JSON.parse(row.created_by_json as string),
    reviewedBy: row.reviewed_by_json ? JSON.parse(row.reviewed_by_json as string) : undefined,
    reviewId: (row.review_id ?? undefined) as string | undefined,
  }
}

export interface MemoryFilter {
  status?: MemoryStatus | MemoryStatus[]
  kind?: MemoryKind | MemoryKind[]
  sessionId?: string
  repositoryId?: string
  projectId?: string
  branch?: string
  trustLevel?: TrustLevel
  tags?: string[]
  limit?: number
}

export class MemoryStore {
  constructor(private dbs: Databases) {}

  private get db(): Database { return this.dbs.store }

  create(record: MemoryRecord): void {
    const now = new Date().toISOString()
    const rec: MemoryRecord = { ...record, createdAt: now, updatedAt: now }
    this.db.prepare(
      `INSERT INTO memories (
        id, schema_version, kind, status, statement, statement_hash,
        structured_payload_json, scope_json, source_json, evidence_json,
        confidence, trust_level, durability, valid_from, valid_until,
        supersedes_json, superseded_by, tags_json, backend_mappings_json,
        created_at, updated_at, created_by_json, reviewed_by_json, review_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      rec.id, rec.schemaVersion, rec.kind, rec.status, rec.statement,
      statementHash(rec.statement),
      rec.structuredPayload ? JSON.stringify(rec.structuredPayload) : null,
      JSON.stringify(rec.scope), JSON.stringify(rec.source), JSON.stringify(rec.evidence),
      rec.confidence, rec.trustLevel, rec.durability, rec.validFrom ?? null, rec.validUntil ?? null,
      JSON.stringify(rec.supersedes), rec.supersededBy ?? null, JSON.stringify(rec.tags),
      rec.backendMappings ? JSON.stringify(rec.backendMappings) : null,
      rec.createdAt, rec.updatedAt, JSON.stringify(rec.createdBy),
      rec.reviewedBy ? JSON.stringify(rec.reviewedBy) : null, rec.reviewId ?? null,
    )
    this.indexFts(rec)
  }

  private indexFts(rec: MemoryRecord): void {
    this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(rec.id)
    this.db.prepare(
      "INSERT INTO memory_fts (memory_id, statement, tags, kind) VALUES (?,?,?,?)",
    ).run(rec.id, rec.statement, rec.tags.join(" "), rec.kind)
  }

  private removeFts(id: string): void {
    this.db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id)
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id)
    return row ? rowToMemory(row as Record<string, unknown>) : null
  }

  getMany(ids: string[]): MemoryRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(",")
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord | null {
    const current = this.get(id)
    if (!current) return null
    const next: MemoryRecord = { ...current, ...patch, id, updatedAt: new Date().toISOString() }
    if (patch.status && patch.status !== current.status) {
      if (!canTransition(current.status, patch.status)) {
        throw new Error(`invalid transition ${current.status} -> ${patch.status} for ${id}`)
      }
    }
    this.db.prepare(
      `UPDATE memories SET
        status=?, statement=?, statement_hash=?, structured_payload_json=?,
        scope_json=?, evidence_json=?, confidence=?, trust_level=?,
        valid_from=?, valid_until=?, supersedes_json=?, superseded_by=?,
        tags_json=?, backend_mappings_json=?, updated_at=?,
        reviewed_by_json=?, review_id=?
       WHERE id = ?`,
    ).run(
      next.status, next.statement, statementHash(next.statement),
      next.structuredPayload ? JSON.stringify(next.structuredPayload) : null,
      JSON.stringify(next.scope), JSON.stringify(next.evidence), next.confidence,
      next.trustLevel, next.validFrom ?? null, next.validUntil ?? null,
      JSON.stringify(next.supersedes), next.supersededBy ?? null, JSON.stringify(next.tags),
      next.backendMappings ? JSON.stringify(next.backendMappings) : null,
      next.updatedAt, next.reviewedBy ? JSON.stringify(next.reviewedBy) : null,
      next.reviewId ?? null, id,
    )
    this.indexFts(next)
    return next
  }

  setBackendMapping(id: string, mappings: BackendMapping[]): void {
    this.db.prepare("UPDATE memories SET backend_mappings_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(mappings), new Date().toISOString(), id)
  }

  list(filter: MemoryFilter = {}): MemoryRecord[] {
    const where: string[] = []
    const args: Array<string | number> = []
    const pushIn = (col: string, v: MemoryStatus | MemoryKind | MemoryStatus[] | MemoryKind[] | undefined) => {
      if (v == null) return
      const arr = Array.isArray(v) ? v : [v]
      if (arr.length === 0) return
      const ph = arr.map(() => "?").join(",")
      where.push(`${col} IN (${ph})`)
      args.push(...(arr as string[]))
    }
    pushIn("status", filter.status)
    pushIn("kind", filter.kind)
    if (filter.trustLevel) {
      where.push("trust_level = ?")
      args.push(filter.trustLevel)
    }
    if (filter.sessionId) {
      where.push("scope_json LIKE ?")
      args.push(`%"sessionId":"${filter.sessionId}"%`)
    }
    if (filter.repositoryId) {
      where.push("scope_json LIKE ?")
      args.push(`%"repositoryId":"${filter.repositoryId}"%`)
    }
    if (filter.projectId) {
      where.push("scope_json LIKE ?")
      args.push(`%"projectId":"${filter.projectId}"%`)
    }
    if (filter.branch) {
      where.push("scope_json LIKE ?")
      args.push(`%"branch":"${filter.branch}"%`)
    }
    if (filter.tags && filter.tags.length) {
      for (const t of filter.tags) {
        where.push("tags_json LIKE ?")
        args.push(`%"${t}"%`)
      }
    }
    const limit = filter.limit ?? 200
    const sql = "SELECT * FROM memories" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT ?"
    args.push(limit)
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  listPending(limit: number = 50): MemoryRecord[] {
    return this.list({ status: "pending", limit })
  }

  byStatementHash(hash: string): MemoryRecord[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE statement_hash = ? ORDER BY created_at DESC").all(hash) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  /** Local FTS5 search. Returns ranked candidate memories for the LocalBackend. */
  ftsSearch(query: string, limit: number): { record: MemoryRecord; rank: number }[] {
    const terms = normalizeStatement(query).split(" ").filter((t) => t.length > 1)
    if (terms.length === 0) return []
    const ftsQuery = terms.map((t) => t.replace(/["'*]/g, "").replace(/[()[\]{}:^"]/g, "")).filter((t) => t.length > 1).join(" ")
    if (ftsQuery.length === 0) return []
    try {
      const rows = this.db.prepare(
        `SELECT m.*, f.rank FROM memory_fts f JOIN memories m ON m.id = f.memory_id
         WHERE memory_fts MATCH ? ORDER BY f.rank LIMIT ?`,
      ).all(ftsQuery, limit) as Record<string, unknown>[]
      return rows.map((r) => {
        const { rank, ...mem } = r
        return { record: rowToMemory(mem as Record<string, unknown>), rank: -Math.abs(rank as number) }
      })
    } catch {
      return []
    }
  }

  // ── Reviews ──────────────────────────────────────────────────────────────

  createReview(review: MemoryReview): void {
    this.db.prepare(
      `INSERT INTO reviews (id, memory_id, decision, reviewer_json, rationale, edited_statement, edited_payload_json, edited_scope_json, duplicate_of, superseded_by_memory_id, escalate_to, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      review.id, review.memoryId, review.decision, JSON.stringify(review.reviewer),
      review.rationale, review.editedStatement ?? null,
      review.editedPayload ? JSON.stringify(review.editedPayload) : null,
      review.editedScope ? JSON.stringify(review.editedScope) : null,
      review.duplicateOf ?? null, review.supersededByMemoryId ?? null,
      review.escalateTo ?? null, review.createdAt,
    )
  }

  reviewsFor(memoryId: string): MemoryReview[] {
    const rows = this.db.prepare("SELECT * FROM reviews WHERE memory_id = ? ORDER BY created_at ASC").all(memoryId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      memoryId: r.memory_id as string,
      decision: r.decision as MemoryReview["decision"],
      reviewer: JSON.parse(r.reviewer_json as string),
      rationale: r.rationale as string,
      editedStatement: (r.edited_statement ?? undefined) as string | undefined,
      editedPayload: r.edited_payload_json ? JSON.parse(r.edited_payload_json as string) : undefined,
      editedScope: r.edited_scope_json ? JSON.parse(r.edited_scope_json as string) : undefined,
      duplicateOf: (r.duplicate_of ?? undefined) as string | undefined,
      supersededByMemoryId: (r.superseded_by_memory_id ?? undefined) as string | undefined,
      escalateTo: (r.escalate_to ?? undefined) as "human" | "agent" | undefined,
      createdAt: r.created_at as string,
    }))
  }

  // ── Conflicts ────────────────────────────────────────────────────────────

  createConflict(conflict: MemoryConflict): void {
    this.db.prepare(
      `INSERT INTO conflicts (id, memory_ids_json, candidate_ids_json, conflict_type, status, evidence_json, resolution, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      conflict.id, JSON.stringify(conflict.memoryIds), JSON.stringify(conflict.candidateIds),
      conflict.conflictType, conflict.status, JSON.stringify(conflict.evidence),
      conflict.resolution ?? null, conflict.createdAt, conflict.updatedAt,
    )
  }

  resolveConflict(id: string, status: MemoryConflict["status"], resolution: string): void {
    this.db.prepare("UPDATE conflicts SET status = ?, resolution = ?, updated_at = ? WHERE id = ?")
      .run(status, resolution, new Date().toISOString(), id)
  }

  openConflictsFor(memoryIds: string[]): MemoryConflict[] {
    if (memoryIds.length === 0) return []
    const rows = this.db.prepare("SELECT * FROM conflicts WHERE status = 'open'").all() as Record<string, unknown>[]
    const set = new Set(memoryIds)
    return rows
      .map((r) => ({
        id: r.id as string,
        memoryIds: JSON.parse(r.memory_ids_json as string),
        candidateIds: JSON.parse(r.candidate_ids_json as string),
        conflictType: r.conflict_type as MemoryConflict["conflictType"],
        status: r.status as MemoryConflict["status"],
        evidence: JSON.parse(r.evidence_json as string),
        resolution: (r.resolution ?? undefined) as string | undefined,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      }))
      .filter((c: MemoryConflict) => c.memoryIds.some((id: string) => set.has(id)))
  }

  // ── Capsules ────────────────────────────────────────────────────────────

  createCapsule(capsule: SessionCapsule): void {
    this.db.prepare(
      `INSERT INTO capsules (id, session_id, scope_json, objective, outcome, body_json, source, evidence_event_ids_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      capsule.id, capsule.sessionId, JSON.stringify(capsule.scope), capsule.objective,
      capsule.outcome, JSON.stringify(capsule), capsule.source,
      JSON.stringify(capsule.evidenceEventIds), capsule.createdAt,
    )
  }

  getCapsule(id: string): SessionCapsule | null {
    const row = this.db.prepare("SELECT body_json FROM capsules WHERE id = ?").get(id) as { body_json: string } | null
    return row ? JSON.parse(row.body_json) : null
  }

  listCapsules(sessionId: string): SessionCapsule[] {
    const rows = this.db.prepare("SELECT body_json FROM capsules WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as { body_json: string }[]
    return rows.map((r) => JSON.parse(r.body_json))
  }

  // ── Relations ───────────────────────────────────────────────────────────

  upsertRelation(id: string, subjectId: string, predicate: RelationKind, objectId: string, evidence: EvidenceReference[], confidence: number): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO relations (id, subject_id, predicate, object_id, evidence_json, confidence, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json, confidence=excluded.confidence, created_at=excluded.created_at`,
    ).run(id, subjectId, predicate, objectId, JSON.stringify(evidence), confidence, now)
  }

  relationsFor(subjectId: string): { id: string; subjectId: string; predicate: RelationKind; objectId: string; evidence: EvidenceReference[]; confidence: number }[] {
    const rows = this.db.prepare("SELECT * FROM relations WHERE subject_id = ?").all(subjectId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      subjectId: r.subject_id as string,
      predicate: r.predicate as RelationKind,
      objectId: r.object_id as string,
      evidence: JSON.parse(r.evidence_json as string),
      confidence: r.confidence as number,
    }))
  }
}

export function buildMemoryRecord(input: {
  kind: MemoryKind
  statement: string
  scope: MemoryScope
  source: MemoryRecord["source"]
  evidence: EvidenceReference[]
  confidence: number
  trustLevel: TrustLevel
  durability: MemoryRecord["durability"]
  validFrom?: string
  validUntil?: string
  supersedes?: string[]
  tags?: string[]
  createdBy: ActorReference
}): MemoryRecord {
  const now = new Date().toISOString()
  return {
    id: memoryId(),
    schemaVersion: 1,
    kind: input.kind,
    status: "pending",
    statement: input.statement.trim(),
    scope: input.scope,
    source: input.source,
    evidence: input.evidence,
    confidence: input.confidence,
    trustLevel: input.trustLevel,
    durability: input.durability,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    supersedes: input.supersedes ?? [],
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  }
}
