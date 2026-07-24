/**
 * plugin/memory/domain.ts — backend-neutral memory domain model.
 *
 * Pure types, IDs, scope logic, lifecycle state machine, trust/ranking,
 * candidate validation, and dedup helpers. No IO, no Supermemory concepts,
 * no SQLite. Everything else in the system composes these primitives.
 *
 * The governing principle: evidence is not knowledge; agents propose and
 * governance decides; indexes are derived and replaceable.
 */
import { createHash, randomUUID } from "node:crypto"

// ─── Kinds, status, trust ───────────────────────────────────────────────────

export type MemoryKind =
  | "fact"
  | "decision"
  | "requirement"
  | "constraint"
  | "preference"
  | "procedure"
  | "lesson"
  | "incident"
  | "hypothesis"
  | "episode"
  | "artifact"
  | "relation"

export type MemoryStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "challenged"
  | "superseded"
  | "expired"
  | "observational"

export type TrustLevel =
  | "user_asserted"
  | "repository_verified"
  | "deterministically_observed"
  | "reviewer_approved"
  | "agent_proposed"
  | "automatically_extracted"
  | "hypothetical"

export type RelationKind =
  | "depends_on"
  | "supersedes"
  | "contradicts"
  | "supports"
  | "related_to"
  | "part_of"
  | "caused_by"
  | "alternative_to"

export type Durability = "session" | "project" | "long_term"

export type Origin =
  | "interactive_agent"
  | "memory_extractor"
  | "memory_reviewer"
  | "human"
  | "system"

export type EvidenceEventType =
  | "session.started" | "session.idle" | "session.completed" | "session.failed"
  | "session.compacted"
  | "message.user" | "message.agent"
  | "tool.before" | "tool.after" | "tool.error"
  | "file.read" | "file.changed" | "file.deleted"
  | "git.state" | "git.commit"
  | "permission.requested" | "permission.resolved"
  | "agent.delegated" | "agent.completed"
  | "memory.explicit" | "checkpoint.requested"
  | "todo.updated" | "command.executed"

export type EvidenceSourceType =
  | "message.user"
  | "message.agent"
  | "tool.before"
  | "tool.after"
  | "tool.error"
  | "file.read"
  | "file.changed"
  | "file.deleted"
  | "git.state"
  | "git.commit"
  | "session.started"
  | "session.idle"
  | "session.completed"
  | "session.failed"
  | "session.compacted"
  | "permission.requested"
  | "permission.resolved"
  | "agent.delegated"
  | "agent.completed"
  | "memory.explicit"
  | "checkpoint.requested"
  | "todo.updated"
  | "command.executed"

// ─── Scope ──────────────────────────────────────────────────────────────────

export interface MemoryScope {
  userId?: string
  organizationId?: string
  workspaceId?: string
  projectId?: string
  repositoryId?: string
  repositoryRemote?: string
  branch?: string
  worktreeId?: string
  commitFrom?: string
  commitTo?: string
  component?: string
  environment?: string
  sessionId?: string
}

export interface MemoryScopeSelector extends Partial<MemoryScope> {
  match?: "exact" | "include_narrower" | "include_broader"
}

// Scope specificity, most-specific first. Higher = narrower.
const SCOPE_RANK: Record<keyof MemoryScope, number> = {
  sessionId: 6,
  commitFrom: 5,
  commitTo: 5,
  branch: 4,
  worktreeId: 4,
  component: 3,
  environment: 3,
  repositoryId: 2,
  repositoryRemote: 2,
  projectId: 1,
  workspaceId: 0,
  organizationId: -1,
  userId: -2,
}

/** Stable hierarchical key for a scope. Narrower scope => longer key. */
export function scopeKey(scope: MemoryScope): string {
  const parts: string[] = []
  if (scope.userId) parts.push("u:" + scope.userId)
  if (scope.organizationId) parts.push("o:" + scope.organizationId)
  if (scope.workspaceId) parts.push("w:" + scope.workspaceId)
  if (scope.projectId) parts.push("p:" + scope.projectId)
  if (scope.repositoryId) parts.push("r:" + scope.repositoryId)
  if (scope.branch) parts.push("b:" + scope.branch)
  if (scope.worktreeId) parts.push("wt:" + scope.worktreeId)
  if (scope.commitFrom) parts.push("cf:" + scope.commitFrom)
  if (scope.commitTo) parts.push("ct:" + scope.commitTo)
  if (scope.component) parts.push("c:" + scope.component)
  if (scope.environment) parts.push("e:" + scope.environment)
  if (scope.sessionId) parts.push("s:" + scope.sessionId)
  return parts.join("|")
}

/** Distinct container-tag value for a scope (broadest shared space). */
export function scopeContainerTag(scope: MemoryScope): string {
  if (scope.userId) return "user:" + scope.userId
  if (scope.workspaceId) return "workspace:" + scope.workspaceId
  return "global"
}

export function scopeDepth(scope: MemoryScope): number {
  let depth = 0
  for (const key of Object.keys(scope) as (keyof MemoryScope)[]) {
    if (scope[key] != null && key in SCOPE_RANK) depth++
  }
  return depth
}

/** Whether `candidate` scope is visible from `current` scope. */
export function scopeCompatible(current: MemoryScope, candidate: MemoryScope): boolean {
  // A candidate is visible if every dimension it specifies is either
  // unspecified in current (broader-than-current => visible) or equal.
  const dims: (keyof MemoryScope)[] = [
    "userId", "organizationId", "workspaceId", "projectId",
    "repositoryId", "branch", "worktreeId", "component", "environment",
  ]
  for (const dim of dims) {
    const c = candidate[dim]
    const n = current[dim]
    if (c != null && n != null && c !== n) return false
  }
  // Commit-bounded candidate: only visible when current commit within range.
  if (candidate.commitFrom || candidate.commitTo) {
    if (!current.commitFrom) return false
    if (candidate.commitFrom && current.commitFrom < candidate.commitFrom) return false
    if (candidate.commitTo && current.commitFrom > candidate.commitTo) return false
  }
  // Session-scoped candidate: only within that session unless caller broadens.
  if (candidate.sessionId && candidate.sessionId !== current.sessionId) {
    return false
  }
  return true
}

export function scopeMultiplier(current: MemoryScope, candidate: MemoryScope): number {
  if (!scopeCompatible(current, candidate)) return 0
  let mult = 0.85
  if (candidate.sessionId && current.sessionId === candidate.sessionId) mult = 1.15
  else if (candidate.branch && current.branch === candidate.branch) mult = 1.1
  else if (candidate.commitFrom && current.commitFrom === candidate.commitFrom) mult = 1.1
  else if (candidate.repositoryId && current.repositoryId === candidate.repositoryId) mult = 1.0
  else if (candidate.projectId && current.projectId === candidate.projectId) mult = 0.9
  else if (candidate.workspaceId && current.workspaceId === candidate.workspaceId) mult = 0.8
  else if (candidate.userId && current.userId === candidate.userId) mult = 0.75
  return mult
}

// ─── Provenance ─────────────────────────────────────────────────────────────

export interface ActorReference {
  kind: "agent" | "user" | "reviewer" | "extractor" | "system"
  id: string
  model?: string
}

export function actorRef(kind: ActorReference["kind"], id: string, model?: string): ActorReference {
  return { kind, id, model }
}

export interface RepositoryContext {
  root?: string
  remote?: string
  branch?: string
  commit?: string
  dirty?: boolean
}

export interface BlobReference {
  blobId: string
  sha256: string
  byteSize: number
  mimeType?: string
}

export interface EvidenceReference {
  eventId?: string
  blobId?: string
  repository?: string
  commit?: string
  filePath?: string
  lineStart?: number
  lineEnd?: number
  externalUrl?: string
  description?: string
}

export interface MemorySource {
  type: EvidenceSourceType | "explicit" | "opencode_compaction" | "agent_checkpoint" | "merged"
  origin: Origin
  actor: ActorReference
  extractorModel?: string
}

// ─── Evidence events ─────────────────────────────────────────────────────────

export type SensitivityClassification = "public" | "internal" | "confidential" | "restricted"

export type RetentionClass = "ephemeral" | "standard" | "extended" | "permanent"

export interface RedactionResult {
  applied: boolean
  fieldCount: number
  patterns: string[]
  note?: string
}

export interface CapturePolicy {
  memoryCapture: boolean
  extractionEligible: boolean
  retentionClass: RetentionClass
}

export interface EvidenceEvent {
  id: string
  schemaVersion: number
  instanceId: string
  projectId?: string
  sessionId: string
  sequence: number
  type: EvidenceEventType
  timestamp: string
  actor: ActorReference
  origin: Origin
  repository?: RepositoryContext
  summary: string
  payload?: Record<string, unknown>
  payloadRef?: BlobReference
  sensitivity: SensitivityClassification
  redaction: RedactionResult
  capturePolicy: CapturePolicy
}

// ─── Memory record ───────────────────────────────────────────────────────────

export interface BackendMapping {
  backend: string
  backendId: string
  containerTag?: string
  indexedAt: string
}

export interface MemoryRecord {
  id: string
  schemaVersion: number
  kind: MemoryKind
  status: MemoryStatus
  statement: string
  structuredPayload?: Record<string, unknown>
  scope: MemoryScope
  source: MemorySource
  evidence: EvidenceReference[]
  confidence: number
  trustLevel: TrustLevel
  durability: Durability
  validFrom?: string
  validUntil?: string
  supersedes: string[]
  supersededBy?: string
  tags: string[]
  createdAt: string
  updatedAt: string
  createdBy: ActorReference
  reviewedBy?: ActorReference
  reviewId?: string
  backendMappings?: BackendMapping[]
}

export interface MemoryReview {
  id: string
  memoryId: string
  decision: "approve" | "reject" | "edit_and_approve" | "duplicate" | "supersede" | "escalate"
  reviewer: ActorReference
  rationale: string
  editedStatement?: string
  editedPayload?: Record<string, unknown>
  editedScope?: MemoryScope
  duplicateOf?: string
  supersededByMemoryId?: string
  escalateTo?: "human" | "agent"
  createdAt: string
}

export interface MemoryConflict {
  id: string
  memoryIds: string[]
  candidateIds: string[]
  conflictType: "direct_contradiction" | "temporal_change" | "scope_mismatch" | "source_disagreement" | "ambiguous"
  status: "open" | "resolved" | "accepted_temporal_change" | "dismissed"
  evidence: EvidenceReference[]
  resolution?: string
  createdAt: string
  updatedAt: string
}

// ─── Session capsule ─────────────────────────────────────────────────────────

export interface FileChangeSummary {
  path: string
  additions?: number
  deletions?: number
  status: "added" | "modified" | "deleted" | "renamed"
}

export interface CommandObservation {
  command: string
  exitCode?: number
  outcome: string
}

export interface FailureSummary {
  summary: string
  errorCategory?: string
}

export interface ResolutionSummary {
  problem: string
  resolution: string
}

export interface SessionCapsule {
  id: string
  sessionId: string
  scope: MemoryScope
  objective: string
  outcome: "completed" | "partial" | "failed" | "abandoned" | "ongoing"
  userRequirements: string[]
  decisions: string[]
  discoveries: string[]
  filesChanged: FileChangeSummary[]
  commandsOfInterest: CommandObservation[]
  failures: FailureSummary[]
  resolutions: ResolutionSummary[]
  unresolvedQuestions: string[]
  nextActions: string[]
  evidenceEventIds: string[]
  source: "memory_extractor" | "opencode_compaction" | "agent_checkpoint" | "merged"
  createdAt: string
}

export interface SessionCapsuleSummary {
  capsuleId: string
  sessionId: string
  objective: string
  outcome: SessionCapsule["outcome"]
  createdAt: string
}

// ─── Extraction result ──────────────────────────────────────────────────────

export interface ExtractedCandidate {
  kind: MemoryKind
  statement: string
  structuredPayload?: Record<string, unknown>
  scope: MemoryScope
  evidenceEventIds: string[]
  confidence: number
  durability: Durability
  validFrom?: string
  validUntil?: string
  importance: "low" | "medium" | "high"
  reviewRecommendation: "auto_observational" | "auto_accept" | "agent_review" | "human_review"
  rationale: string
}

export interface ExtractedRelation {
  subjectEventId?: string
  subjectStatementHash?: string
  predicate: RelationKind
  objectEventId?: string
  objectStatementHash?: string
  confidence: number
  rationale: string
}

export interface ExtractedContradiction {
  candidateIndex: number
  conflictsWithStatementHash?: string
  conflictsWithStatement?: string
  conflictType: MemoryConflict["conflictType"]
  explanation: string
}

export interface IgnoredObservation {
  summary: string
  reason: string
}

export interface ExtractionResult {
  capsulePatch?: Partial<SessionCapsule>
  candidates: ExtractedCandidate[]
  relations: ExtractedRelation[]
  contradictions: ExtractedContradiction[]
  ignoredObservations: IgnoredObservation[]
}

// ─── Retrieval ──────────────────────────────────────────────────────────────

export interface MemoryContextItem {
  memoryId: string
  kind: MemoryKind
  status: MemoryStatus
  statement: string
  trustLevel: TrustLevel
  confidence: number
  scope: MemoryScope
  score: number
  evidenceCount: number
  tags: string[]
  validFrom?: string
  validUntil?: string
  createdAt: string
  sourceType: string
}

export interface MemoryConflictSummary {
  conflictId: string
  conflictType: MemoryConflict["conflictType"]
  memoryIds: string[]
  status: MemoryConflict["status"]
}

export interface MemoryContextBundle {
  summary?: string
  memories: MemoryContextItem[]
  unresolvedContradictions: MemoryConflictSummary[]
  relevantEpisodes: SessionCapsuleSummary[]
  truncated: boolean
}

// ─── IDs ─────────────────────────────────────────────────────────────────────

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

export function memoryId(): string {
  return "mem_" + randomUUID().replace(/-/g, "").slice(0, 24)
}

export function reviewId(): string {
  return "rev_" + randomUUID().replace(/-/g, "").slice(0, 24)
}

export function conflictId(): string {
  return "cf_" + randomUUID().replace(/-/g, "").slice(0, 24)
}

export function batchId(): string {
  return "batch_" + randomUUID().replace(/-/g, "").slice(0, 24)
}

export function capsuleId(): string {
  return "cap_" + randomUUID().replace(/-/g, "").slice(0, 24)
}

/** Deterministic event id from stable data. Never timestamp-only. */
export function eventId(
  instanceId: string,
  sessionId: string,
  normalizedType: EvidenceEventType,
  sourceEventId: string,
  revision: number = 0,
): string {
  return "evt_" + shortHash([instanceId, sessionId, normalizedType, sourceEventId, revision].join("\u0001"))
}

export function statementHash(statement: string): string {
  return "sh_" + shortHash(normalizeStatement(statement))
}

export function normalizeStatement(statement: string): string {
  return statement
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

// ─── Lifecycle state machine ────────────────────────────────────────────────

const TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  pending: ["approved", "rejected", "observational", "challenged", "superseded", "expired"],
  approved: ["challenged", "superseded", "expired", "rejected"],
  rejected: ["approved", "challenged"],
  challenged: ["approved", "rejected", "superseded", "expired"],
  superseded: [],
  expired: [],
  observational: ["approved", "rejected", "expired", "superseded"],
}

export function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

export const STATUS_MULTIPLIER: Record<MemoryStatus, number> = {
  approved: 1.0,
  observational: 0.8,
  challenged: 0.55,
  pending: 0.35,
  rejected: 0.0,
  superseded: 0.0,
  expired: 0.0,
}

export const TRUST_MULTIPLIER: Record<TrustLevel, number> = {
  user_asserted: 1.2,
  repository_verified: 1.15,
  deterministically_observed: 1.05,
  reviewer_approved: 1.0,
  agent_proposed: 0.85,
  automatically_extracted: 0.7,
  hypothetical: 0.4,
}

export interface RankingWeights {
  status: typeof STATUS_MULTIPLIER
  trust: typeof TRUST_MULTIPLIER
  evidenceFloor: number
  conflictPenalty: number
  recencyDecayDays: number
}

export function defaultRankingWeights(): RankingWeights {
  return {
    status: STATUS_MULTIPLIER,
    trust: TRUST_MULTIPLIER,
    evidenceFloor: 0.5,
    conflictPenalty: 0.5,
    recencyDecayDays: 180,
  }
}

export function recencyMultiplier(createdAt: string, validFrom?: string, validUntil?: string, now: number = Date.now()): number {
  const ref = validFrom ? Date.parse(validFrom) : Date.parse(createdAt)
  if (!Number.isFinite(ref)) return 0.7
  const ageDays = (now - ref) / 86_400_000
  const decay = Math.exp(-ageDays / (180 * 1.0))
  let mult = 0.6 + 0.4 * decay
  if (validUntil) {
    if (Date.parse(validUntil) < now) mult = 0
  }
  return mult
}

export function evidenceMultiplier(count: number): number {
  if (count <= 0) return 0.5
  return Math.min(1.0, 0.6 + count * 0.1)
}

export function rankResult(
  semanticScore: number,
  record: Pick<MemoryRecord, "status" | "trustLevel" | "confidence" | "evidence" | "createdAt" | "validFrom" | "validUntil">,
  currentScope: MemoryScope,
  candidateScope: MemoryScope,
  hasOpenConflict: boolean,
  weights: RankingWeights = defaultRankingWeights(),
): number {
  const scopeMult = scopeMultiplier(currentScope, candidateScope)
  if (scopeMult === 0) return 0
  const status = weights.status[record.status] ?? 0
  if (status === 0) return 0
  const trust = weights.trust[record.trustLevel] ?? 0.7
  const evidence = evidenceMultiplier(record.evidence.length)
  const conflict = hasOpenConflict ? weights.conflictPenalty : 1
  const recency = recencyMultiplier(record.createdAt, record.validFrom, record.validUntil)
  const confidence = Math.max(0, Math.min(1, record.confidence))
  return (
    semanticScore *
    status *
    trust *
    scopeMult *
    recency *
    evidence *
    conflict *
    (0.7 + 0.3 * confidence)
  )
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  field?: string
  message: string
}

const MAX_STATEMENT = 4000
const SUPPORTED_KINDS = new Set<MemoryKind>([
  "fact", "decision", "requirement", "constraint", "preference", "procedure",
  "lesson", "incident", "hypothesis", "episode", "artifact", "relation",
])

export function validatePropose(input: {
  kind: MemoryKind
  statement: string
  scope: MemoryScope
  confidence: number
  durability: Durability
}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!SUPPORTED_KINDS.has(input.kind)) issues.push({ field: "kind", message: `unsupported kind: ${input.kind}` })
  const stmt = input.statement?.trim() ?? ""
  if (stmt.length === 0) issues.push({ field: "statement", message: "statement is empty" })
  if (stmt.length > MAX_STATEMENT) issues.push({ field: "statement", message: `statement too long (${stmt.length} > ${MAX_STATEMENT})` })
  if (!input.scope || scopeDepth(input.scope) === 0) issues.push({ field: "scope", message: "scope is empty" })
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    issues.push({ field: "confidence", message: "confidence must be in [0,1]" })
  }
  if (!["session", "project", "long_term"].includes(input.durability)) {
    issues.push({ field: "durability", message: "invalid durability" })
  }
  return issues
}

export function validateCandidate(candidate: ExtractedCandidate, knownEventIds: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const base = validatePropose({
    kind: candidate.kind,
    statement: candidate.statement,
    scope: candidate.scope,
    confidence: candidate.confidence,
    durability: candidate.durability,
  })
  issues.push(...base)
  if (candidate.evidenceEventIds.length === 0) {
    issues.push({ field: "evidenceEventIds", message: "every candidate must cite evidence event ids" })
  } else {
    for (const eid of candidate.evidenceEventIds) {
      if (!knownEventIds.has(eid)) issues.push({ field: "evidenceEventIds", message: `unknown event id: ${eid}` })
    }
  }
  if (candidate.reviewRecommendation === "auto_accept" && candidate.evidenceEventIds.length === 0) {
    issues.push({ field: "reviewRecommendation", message: "cannot auto-accept without evidence" })
  }
  return issues
}

export function isExpired(record: MemoryRecord, now: number = Date.now()): boolean {
  if (record.validUntil && Date.parse(record.validUntil) < now) return true
  if (record.status === "expired" || record.status === "superseded") return true
  return false
}

export function indexEligible(record: MemoryRecord, includePending: boolean = false): boolean {
  if (record.status === "approved") return true
  if (record.status === "observational") return true
  if (record.status === "challenged") return true
  if (includePending && record.status === "pending") return true
  return false
}

export function redacted(value: string): string {
  return value.length > 8 ? value.slice(0, 4) + "…" : "…"
}
