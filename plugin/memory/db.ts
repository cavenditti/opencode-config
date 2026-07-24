/**
 * plugin/memory/db.ts — SQLite (bun:sqlite) persistence for the journal,
 * memory lifecycle, reviews, conflicts, and capsules, plus a content store
 * for redacted evidence blobs.
 *
 * Two logically separated databases share the same schema family:
 *  - events.db  : raw evidence journal + worker state (processing_batches, blobs)
 *  - memories.db: canonical memory domain (memories, reviews, conflicts, capsules)
 *
 * For a single-user local install both may live in one file; we keep them
 * separate so raw evidence can be pruned independently of canonical knowledge.
 */
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"

export interface DbPaths {
  journalPath: string
  storePath: string
  blobsDir: string
}

export interface Databases {
  journal: Database
  store: Database
  paths: DbPaths
  close(): void
}

const SCHEMA_JOURNAL = `
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    origin TEXT NOT NULL,
    repository_json TEXT,
    summary TEXT NOT NULL,
    payload_json TEXT,
    payload_ref TEXT,
    sensitivity TEXT NOT NULL,
    redaction_json TEXT NOT NULL,
    capture_policy_json TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processing_status) WHERE processing_status='pending';
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, session_id);

CREATE TABLE IF NOT EXISTS processing_batches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    candidate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batches_session ON processing_batches(session_id);

CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    storage_path TEXT NOT NULL,
    mime_type TEXT,
    byte_size INTEGER NOT NULL,
    retention_class TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_state (
    session_id TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    last_eligible_at TEXT,
    updated_at TEXT NOT NULL
);
`

const SCHEMA_STORE = `
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    statement TEXT NOT NULL,
    statement_hash TEXT NOT NULL,
    structured_payload_json TEXT,
    scope_json TEXT NOT NULL,
    source_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    trust_level TEXT NOT NULL,
    durability TEXT NOT NULL,
    valid_from TEXT,
    valid_until TEXT,
    supersedes_json TEXT NOT NULL DEFAULT '[]',
    superseded_by TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    backend_mappings_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_json TEXT NOT NULL,
    reviewed_by_json TEXT,
    review_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope_json);
CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(statement_hash);
CREATE INDEX IF NOT EXISTS idx_mem_session ON memories(scope_json);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    statement,
    tags,
    kind UNINDEXED,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reviewer_json TEXT NOT NULL,
    rationale TEXT NOT NULL,
    edited_statement TEXT,
    edited_payload_json TEXT,
    edited_scope_json TEXT,
    duplicate_of TEXT,
    superseded_by_memory_id TEXT,
    escalate_to TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_memory ON reviews(memory_id);

CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    memory_ids_json TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL,
    conflict_type TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    resolution TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);

CREATE TABLE IF NOT EXISTS capsules (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    objective TEXT NOT NULL,
    outcome TEXT NOT NULL,
    body_json TEXT NOT NULL,
    source TEXT NOT NULL,
    evidence_event_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capsules_session ON capsules(session_id);

CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object_id TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject_id);
CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(object_id);
`

export function openDatabases(paths: DbPaths): Databases {
  mkdirSync(dirname(paths.journalPath), { recursive: true })
  mkdirSync(dirname(paths.storePath), { recursive: true })
  mkdirSync(paths.blobsDir, { recursive: true })

  const journal = new Database(paths.journalPath, { create: true })
  const store = new Database(paths.storePath, { create: true })

  journal.exec("PRAGMA journal_mode = WAL;")
  journal.exec("PRAGMA synchronous = NORMAL;")
  journal.exec("PRAGMA busy_timeout = 5000;")
  store.exec("PRAGMA journal_mode = WAL;")
  store.exec("PRAGMA synchronous = NORMAL;")
  store.exec("PRAGMA busy_timeout = 5000;")

  journal.exec(SCHEMA_JOURNAL)
  store.exec(SCHEMA_STORE)

  return {
    journal,
    store,
    paths,
    close() {
      try { journal.close() } catch {}
      try { store.close() } catch {}
    },
  }
}

export function writeBlob(paths: DbPaths, blobId: string, sha256: string, data: Uint8Array, mimeType: string, retentionClass: string, db: Database, now: string): string {
  const storagePath = join(paths.blobsDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  mkdirSync(dirname(storagePath), { recursive: true })
  if (!existsSync(storagePath)) writeFileSync(storagePath, data)
  db.prepare(
    "INSERT OR IGNORE INTO blobs (id, sha256, storage_path, mime_type, byte_size, retention_class, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(blobId, sha256, storagePath, mimeType, data.byteLength, retentionClass, now)
  return storagePath
}
