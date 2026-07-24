/**
 * plugin/memory/backend.ts — backend-independent memory index interface.
 *
 * Two implementations:
 *   - LocalBackend:    SQLite FTS5 over the canonical store. Default, zero
 *                      config, works offline. Satisfies "fake backend in
 *                      tests" and "continues operating when Supermemory is
 *                      unavailable".
 *   - SupermemoryBackend: v4 HTTP adapter. Semantic embeddings + metadata
 *                      filtering. Used when SUPERMEMORY_API_KEY is present.
 *
 * The gateway always owns lifecycle/trust; backends are derived indexes.
 * Indexing is best-effort: failures mark the record pending and are retried.
 */
import type { MemoryConfig } from "./config.ts"
import type { Databases } from "./db.ts"
import type { MemoryStore } from "./store.ts"
import type {
  MemoryRecord, MemoryScope, MemoryStatus, MemoryKind, TrustLevel,
} from "./domain.ts"
import { scopeContainerTag } from "./domain.ts"

export interface IndexableMemory {
  id: string
  statement: string
  kind: MemoryKind
  status: MemoryStatus
  scope: MemoryScope
  trustLevel: TrustLevel
  confidence: number
  validFrom?: string
  validUntil?: string
  tags: string[]
  evidenceCount: number
  sourceType: string
  createdBy: string
  backendId?: string
  containerTag?: string
}

export interface BackendSearchQuery {
  query: string
  scopes: MemoryScope[]
  limit: number
  threshold: number
  includePending: boolean
  kinds?: MemoryKind[]
}

export interface BackendSearchResult {
  memoryId: string
  backendId?: string
  score: number
}

export interface BackendRecordReference {
  backend: string
  backendId: string
  containerTag?: string
}

export interface BackendHealth {
  healthy: boolean
  backend: string
  latencyMs?: number
  error?: string
}

export interface MemoryBackend {
  index(record: IndexableMemory): Promise<BackendRecordReference>
  update(reference: BackendRecordReference, record: IndexableMemory): Promise<BackendRecordReference>
  remove(reference: BackendRecordReference): Promise<void>
  search(query: BackendSearchQuery): Promise<BackendSearchResult[]>
  health(): Promise<BackendHealth>
}

function indexableFrom(record: MemoryRecord): IndexableMemory {
  return {
    id: record.id,
    statement: record.statement,
    kind: record.kind,
    status: record.status,
    scope: record.scope,
    trustLevel: record.trustLevel,
    confidence: record.confidence,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    tags: record.tags,
    evidenceCount: record.evidence.length,
    sourceType: record.source.type,
    createdBy: record.createdBy.id,
    containerTag: scopeContainerTag(record.scope),
  }
}

export { indexableFrom }

// ─── Local FTS5 backend ──────────────────────────────────────────────────────

export class LocalBackend implements MemoryBackend {
  constructor(private store: MemoryStore) {}

  async index(record: IndexableMemory): Promise<BackendRecordReference> {
    return { backend: "local", backendId: record.id }
  }

  async update(reference: BackendRecordReference, _record: IndexableMemory): Promise<BackendRecordReference> {
    return reference
  }

  async remove(_reference: BackendRecordReference): Promise<void> {}

  async search(query: BackendSearchQuery): Promise<BackendSearchResult[]> {
    const results = this.store.ftsSearch(query.query, query.limit * 2)
    const seen = new Set<string>()
    const out: BackendSearchResult[] = []
    for (const { record, rank } of results) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      if (!query.includePending && record.status === "pending") continue
      if (query.kinds && query.kinds.length && !query.kinds.includes(record.kind)) continue
      const score = Math.max(0, Math.min(1, (rank + 8) / 8))
      if (score < query.threshold) continue
      out.push({ memoryId: record.id, score })
      if (out.length >= query.limit) break
    }
    return out
  }

  async health(): Promise<BackendHealth> {
    return { healthy: true, backend: "local" }
  }
}

// ─── Supermemory v4 HTTP backend ──────────────────────────────────────────────

export class SupermemoryBackend implements MemoryBackend {
  constructor(private config: MemoryConfig) {}

  private get apiKey(): string {
    return this.config.backend.apiKey ?? process.env[this.config.backend.apiKeyEnv] ?? ""
  }

  private get baseUrl(): string {
    return this.config.backend.baseUrl.replace(/\/$/, "")
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }
  }

  private containerFor(scope: MemoryScope): string {
    const base = scopeContainerTag(scope)
    return this.config.backend.containerTagPrefix + ":" + base
  }

  async index(record: IndexableMemory): Promise<BackendRecordReference> {
    const containerTag = record.containerTag ?? this.containerFor(record.scope)
    const content = this.formatContent(record)
    const res = await fetch(`${this.baseUrl}/v4/memories`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        memories: [{ content, metadata: this.metadataFor(record) }],
        containerTag,
      }),
    })
    if (!res.ok) {
      throw new Error(`supermemory index HTTP ${res.status}: ${await safeText(res)}`)
    }
    const data = await res.json() as { memories?: { id: string }[] }
    const backendId = data.memories?.[0]?.id ?? record.id
    return { backend: "supermemory", backendId, containerTag }
  }

  async update(reference: BackendRecordReference, record: IndexableMemory): Promise<BackendRecordReference> {
    const containerTag = reference.containerTag ?? this.containerFor(record.scope)
    try {
      await fetch(`${this.baseUrl}/v4/memories`, {
        method: "PATCH",
        headers: this.authHeaders(),
        body: JSON.stringify({
          id: reference.backendId,
          newContent: this.formatContent(record),
          metadata: this.metadataFor(record),
        }),
      })
    } catch (error) {
      // PATCH may fail if the memory was forgotten; fall back to re-index.
      return this.index(record)
    }
    return { ...reference, containerTag }
  }

  async remove(reference: BackendRecordReference): Promise<void> {
    if (!reference.backendId) return
    await fetch(`${this.baseUrl}/v4/memories`, {
      method: "DELETE",
      headers: this.authHeaders(),
      body: JSON.stringify({ id: reference.backendId, containerTag: reference.containerTag, reason: "lifecycle transition" }),
    })
  }

  async search(query: BackendSearchQuery): Promise<BackendSearchResult[]> {
    const out: BackendSearchResult[] = []
    // Search each distinct container implied by the scopes (deduped).
    const containers = new Set<string>()
    for (const scope of query.scopes) containers.add(this.containerFor(scope))
    if (containers.size === 0) containers.add(this.config.backend.containerTagPrefix + ":global")
    const filters = this.buildFilters(query)
    for (const containerTag of containers) {
      const body: Record<string, unknown> = {
        q: query.query,
        containerTag,
        searchMode: "memories",
        limit: query.limit,
        threshold: query.threshold,
        rerank: true,
      }
      if (filters) body.filters = filters
      const res = await fetch(`${this.baseUrl}/v4/search`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const data = await res.json() as { results?: { id: string; metadata?: { memoryId?: string } | null; similarity: number }[] }
      for (const r of data.results ?? []) {
        const memoryId = r.metadata?.memoryId
        if (!memoryId) continue
        out.push({ memoryId, backendId: r.id, score: r.similarity })
      }
    }
    // Merge by memoryId keeping highest score.
    const best = new Map<string, BackendSearchResult>()
    for (const r of out) {
      const cur = best.get(r.memoryId)
      if (!cur || r.score > cur.score) best.set(r.memoryId, r)
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, query.limit)
  }

  async health(): Promise<BackendHealth> {
    const start = Date.now()
    try {
      const res = await fetch(`${this.baseUrl}/v4/search`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ q: "__healthcheck__", containerTag: this.config.backend.containerTagPrefix + ":global", searchMode: "memories", limit: 0 }),
        signal: AbortSignal.timeout(4000),
      })
      return { healthy: res.ok, backend: "supermemory", latencyMs: Date.now() - start }
    } catch (error) {
      return { healthy: false, backend: "supermemory", latencyMs: Date.now() - start, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private buildFilters(query: BackendSearchQuery): Record<string, unknown> | undefined {
    const and: { key: string; value: string }[] = []
    const seen = new Set<string>()
    for (const scope of query.scopes) {
      const pairs: [string, string | undefined][] = [
        ["kind", undefined],
      ]
      for (const [k, v] of pairs) {
        if (v != null) {
          const key = k
          if (!seen.has(key + ":" + v)) {
            seen.add(key + ":" + v)
            and.push({ key, value: v })
          }
        }
      }
    }
    if (query.kinds && query.kinds.length === 1) {
      and.push({ key: "kind", value: query.kinds[0] })
    }
    return and.length ? { AND: and } : undefined
  }

  private metadataFor(record: IndexableMemory): Record<string, unknown> {
    return {
      memoryId: record.id,
      schemaVersion: 1,
      kind: record.kind,
      status: record.status,
      projectId: record.scope.projectId ?? null,
      repositoryId: record.scope.repositoryId ?? null,
      branch: record.scope.branch ?? null,
      component: record.scope.component ?? null,
      trustLevel: record.trustLevel,
      confidence: record.confidence,
      validFrom: record.validFrom ?? null,
      validUntil: record.validUntil ?? null,
      createdBy: record.createdBy,
      evidenceCount: record.evidenceCount,
    }
  }

  private formatContent(record: IndexableMemory): string {
    const lines: string[] = []
    lines.push(`[KIND: ${record.kind}]`)
    lines.push(`[STATUS: ${record.status}]`)
    lines.push(`[SCOPE: ${scopeLabel(record.scope)}]`)
    lines.push(`[TRUST: ${record.trustLevel}]`)
    lines.push("")
    lines.push(record.statement)
    if (record.tags.length) lines.push(`Tags: ${record.tags.join(", ")}`)
    return lines.join("\n")
  }
}

function scopeLabel(scope: MemoryScope): string {
  if (scope.repositoryId) return "repository"
  if (scope.projectId) return "project"
  if (scope.workspaceId) return "workspace"
  if (scope.userId) return "global user"
  return "session"
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200) } catch { return "" }
}

// ─── Backend registry ────────────────────────────────────────────────────────

export interface BackendRegistry {
  primary: MemoryBackend
  fallback: MemoryBackend
  type: "local" | "supermemory"
}

export function buildBackends(config: MemoryConfig, dbs: Databases, store: MemoryStore): BackendRegistry {
  const local = new LocalBackend(store)
  if (config.backend.type === "supermemory" && config.backend.apiKey) {
    return { primary: new SupermemoryBackend(config), fallback: local, type: "supermemory" }
  }
  return { primary: local, fallback: local, type: "local" }
}

/** Index a canonical record, falling back to local on backend failure. */
export async function indexWithFallback(
  registry: BackendRegistry,
  record: MemoryRecord,
  onPending?: () => void,
): Promise<BackendRecordReference> {
  try {
    return await registry.primary.index(indexableFrom(record))
  } catch (error) {
    try {
      const ref = await registry.fallback.index(indexableFrom(record))
      onPending?.()
      return ref
    } catch {
      onPending?.()
      return { backend: registry.type, backendId: record.id }
    }
  }
}
