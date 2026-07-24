/**
 * plugin/memory/journal.ts — the local durable evidence journal.
 *
 * The plugin's event hook appends sanitized events here and returns
 * immediately. Nothing in the journal is knowledge; it is raw evidence. The
 * worker consumes pending events in batches and turns them into candidates.
 *
 * All writes are idempotent on event id (deterministic id from stable data,
 * see domain.eventId). Streaming message updates upsert the mutable event
 * until finalized.
 */
import type { Database } from "bun:sqlite"
import { unlinkSync } from "node:fs"
import type {
  EvidenceEvent, EvidenceEventType, ActorReference, RepositoryContext,
  RedactionResult, CapturePolicy, BlobReference,
} from "./domain.ts"
import type { Databases } from "./db.ts"

export interface EventRow {
  id: string
  instance_id: string
  project_id: string | null
  session_id: string
  sequence: number
  event_type: EvidenceEventType
  occurred_at: string
  actor: ActorReference
  origin: string
  repository: RepositoryContext | null
  summary: string
  payload: Record<string, unknown> | null
  payload_ref: BlobReference | null
  sensitivity: string
  redaction: RedactionResult
  capture_policy: CapturePolicy
  processing_status: string
  attempts: number
  last_error: string | null
  created_at: string
}

const COLUMNS = "id, instance_id, project_id, session_id, sequence, event_type, occurred_at, actor_json, origin, repository_json, summary, payload_json, payload_ref, sensitivity, redaction_json, capture_policy_json, processing_status, attempts, last_error, created_at"

function rowToEvent(row: Record<string, unknown>): EventRow {
  return {
    id: row.id as string,
    instance_id: row.instance_id as string,
    project_id: (row.project_id ?? null) as string | null,
    session_id: row.session_id as string,
    sequence: row.sequence as number,
    event_type: row.event_type as EvidenceEventType,
    occurred_at: row.occurred_at as string,
    actor: JSON.parse(row.actor_json as string),
    origin: row.origin as string,
    repository: row.repository_json ? JSON.parse(row.repository_json as string) : null,
    summary: row.summary as string,
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : null,
    payload_ref: row.payload_ref ? JSON.parse(row.payload_ref as string) : null,
    sensitivity: row.sensitivity as string,
    redaction: JSON.parse(row.redaction_json as string),
    capture_policy: JSON.parse(row.capture_policy_json as string),
    processing_status: row.processing_status as string,
    attempts: row.attempts as number,
    last_error: (row.last_error ?? null) as string | null,
    created_at: row.created_at as string,
  }
}

export class Journal {
  constructor(private dbs: Databases) {}

  private get db(): Database { return this.dbs.journal }

  nextSequence(sessionId: string): number {
    this.db.prepare(
      `INSERT INTO sequence_state (session_id, last_sequence, last_eligible_at, updated_at)
       VALUES (?, 0, NULL, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    ).run(sessionId, new Date().toISOString())
    const row = this.db.prepare(
      "UPDATE sequence_state SET last_sequence = last_sequence + 1, updated_at = ? WHERE session_id = ? RETURNING last_sequence",
    ).get(new Date().toISOString(), sessionId) as { last_sequence: number } | null
    return row?.last_sequence ?? 1
  }

  touchEligible(sessionId: string): void {
    this.db.prepare(
      "UPDATE sequence_state SET last_eligible_at = ?, updated_at = ? WHERE session_id = ?",
    ).run(new Date().toISOString(), new Date().toISOString(), sessionId)
  }

  lastEligibleAt(sessionId: string): string | null {
    const row = this.db.prepare(
      "SELECT last_eligible_at FROM sequence_state WHERE session_id = ?",
    ).get(sessionId) as { last_eligible_at: string | null } | null
    return row?.last_eligible_at ?? null
  }

  /** Idempotent append. Upserts mutable events; preserves sequence on conflict. */
  append(event: EvidenceEvent): void {
    this.db.prepare(
      `INSERT INTO events (
        id, instance_id, project_id, session_id, sequence, event_type, occurred_at,
        actor_json, origin, repository_json, summary, payload_json, payload_ref,
        sensitivity, redaction_json, capture_policy_json, processing_status,
        attempts, last_error, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
        summary=excluded.summary,
        payload_json=excluded.payload_json,
        payload_ref=excluded.payload_ref,
        redaction_json=excluded.redaction_json,
        sensitivity=excluded.sensitivity,
        occurred_at=excluded.occurred_at,
        event_type=excluded.event_type`,
    ).run(
      event.id, event.instanceId, event.projectId ?? null, event.sessionId,
      event.sequence, event.type, event.timestamp,
      JSON.stringify(event.actor), event.origin,
      event.repository ? JSON.stringify(event.repository) : null,
      event.summary, event.payload ? JSON.stringify(event.payload) : null,
      event.payloadRef ? JSON.stringify(event.payloadRef) : null,
      event.sensitivity, JSON.stringify(event.redaction), JSON.stringify(event.capturePolicy),
      event.capturePolicy.extractionEligible ? "pending" : "processed",
      0, null, new Date().toISOString(),
    )
  }

  get(id: string): EventRow | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM events WHERE id = ?`).get(id)
    return row ? rowToEvent(row as Record<string, unknown>) : null
  }

  getMany(ids: string[]): EventRow[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(",")
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM events WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[]
    return rows.map(rowToEvent)
  }

  pendingForSession(sessionId: string, limit: number = 200): EventRow[] {
    const rows = this.db.prepare(
      `SELECT ${COLUMNS} FROM events
       WHERE session_id = ? AND processing_status = 'pending'
       ORDER BY sequence ASC LIMIT ?`,
    ).all(sessionId, limit) as Record<string, unknown>[]
    return rows.map(rowToEvent)
  }

  pendingCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE processing_status = 'pending'",
    ).get() as { n: number }
    return row.n
  }

  /** Claim a contiguous range of pending events for a session as a batch. */
  claimBatch(sessionId: string, trigger: string, maxEvents: number): { batchId: string; firstSeq: number; lastSeq: number; events: EventRow[] } | null {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT ${COLUMNS} FROM events
         WHERE session_id = ? AND processing_status = 'pending'
         ORDER BY sequence ASC LIMIT ?`,
      ).all(sessionId, maxEvents) as Record<string, unknown>[]
      if (rows.length === 0) return null
      const events = rows.map(rowToEvent)
      const firstSeq = events[0].sequence
      const lastSeq = events[events.length - 1].sequence
      const batchId = "batch_" + Math.random().toString(36).slice(2, 14) + Date.now().toString(36)
      const ids = events.map((e) => e.id)
      const placeholders = ids.map(() => "?").join(",")
      this.db.prepare(
        `UPDATE events SET processing_status = 'processing', attempts = attempts + 1 WHERE id IN (${placeholders})`,
      ).run(...ids)
      this.db.prepare(
        `INSERT INTO processing_batches (id, session_id, first_sequence, last_sequence, trigger, status, started_at)
         VALUES (?,?,?,?,?, 'processing', ?)`,
      ).run(batchId, sessionId, firstSeq, lastSeq, trigger, new Date().toISOString())
      return { batchId, firstSeq, lastSeq, events }
    })
    return tx()
  }

  markBatch(batchId: string, status: "completed" | "failed" | "deadletter", error: string | null, candidateCount: number): void {
    this.db.prepare(
      `UPDATE processing_batches SET status = ?, completed_at = ?, error = ?, candidate_count = ? WHERE id = ?`,
    ).run(status, new Date().toISOString(), error, candidateCount, batchId)
  }

  /** On success: mark events processed. On failure: release back to pending. */
  settleEvents(eventIds: string[], success: boolean): void {
    if (eventIds.length === 0) return
    const placeholders = eventIds.map(() => "?").join(",")
    if (success) {
      this.db.prepare(
        `UPDATE events SET processing_status = 'processed', last_error = NULL WHERE id IN (${placeholders})`,
      ).run(...eventIds)
    } else {
      this.db.prepare(
        `UPDATE events SET processing_status = 'pending', last_error = ? WHERE id IN (${placeholders})`,
      ).run("batch failed", ...eventIds)
    }
  }

  markDeadletter(eventIds: string[]): void {
    if (eventIds.length === 0) return
    const placeholders = eventIds.map(() => "?").join(",")
    this.db.prepare(
      `UPDATE events SET processing_status = 'deadletter' WHERE id IN (${placeholders})`,
    ).run(...eventIds)
  }

  failedBatches(sessionId: string): { id: string; status: string; error: string | null; attempts: number }[] {
    return this.db.prepare(
      `SELECT b.id, b.status, b.error, COALESCE(MAX(e.attempts), 0) AS attempts
       FROM processing_batches b
       LEFT JOIN events e
         ON e.session_id = b.session_id
        AND e.sequence BETWEEN b.first_sequence AND b.last_sequence
       WHERE b.session_id = ? AND b.status = 'failed'
       GROUP BY b.id, b.status, b.error, b.started_at
       ORDER BY b.started_at DESC`,
    ).all(sessionId) as { id: string; status: string; error: string | null; attempts: number }[]
  }

  /** Replay a session's processed events back to pending for re-extraction. */
  replaySession(sessionId: string): number {
    const tx = this.db.transaction(() => {
      const res = this.db.prepare(
        `UPDATE events SET processing_status = 'pending' WHERE session_id = ? AND processing_status IN ('processed','deadletter')`,
      ).run(sessionId)
      return res.changes
    })
    return tx()
  }

  /** Apply configured retention without deleting pending/in-flight evidence. */
  prune(retainRawDays: number, retainBlobsDays: number, now: number = Date.now()): { events: number; batches: number; blobs: number } {
    const rawCutoff = new Date(now - Math.max(0, retainRawDays) * 86_400_000).toISOString()
    const blobCutoff = new Date(now - Math.max(0, retainBlobsDays) * 86_400_000).toISOString()
    const tx = this.db.transaction(() => {
      const eventResult = this.db.prepare(
        `DELETE FROM events
         WHERE processing_status IN ('processed','deadletter')
           AND created_at < ?
           AND COALESCE(json_extract(capture_policy_json, '$.retentionClass'), 'standard') != 'permanent'`,
      ).run(rawCutoff)
      const batchResult = this.db.prepare(
        "DELETE FROM processing_batches WHERE status IN ('completed','failed','deadletter') AND completed_at < ?",
      ).run(rawCutoff)
      const blobs = this.db.prepare(
        `SELECT b.id, b.storage_path FROM blobs b
         WHERE b.created_at < ? AND b.retention_class != 'permanent'
           AND NOT EXISTS (
             SELECT 1 FROM events e WHERE json_extract(e.payload_ref, '$.blobId') = b.id
           )`,
      ).all(blobCutoff) as { id: string; storage_path: string }[]
      let deletedBlobs = 0
      for (const blob of blobs) {
        try { unlinkSync(blob.storage_path) } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") continue
        }
        this.db.prepare("DELETE FROM blobs WHERE id = ?").run(blob.id)
        deletedBlobs++
      }
      this.db.prepare(
        "DELETE FROM sequence_state WHERE session_id NOT IN (SELECT DISTINCT session_id FROM events)",
      ).run()
      return { events: eventResult.changes, batches: batchResult.changes, blobs: deletedBlobs }
    })
    return tx()
  }
}
