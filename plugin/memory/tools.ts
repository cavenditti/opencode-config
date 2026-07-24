/**
 * plugin/memory/tools.ts — agent-facing memory tool surface.
 *
 * A narrow set of epistemic actions rather than low-level CRUD. Ordinary
 * agents get: context, search, get, propose, relate, challenge, checkpoint.
 * Reviewer agents additionally get: list_pending, review, supersede,
 * merge_duplicates (guarded by agent allowlist).
 *
 * Tools are plain objects built from the @opencode-ai/plugin `tool()`
 * builder; they receive a ToolContext and route to the MemoryGateway.
 */
import { tool } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { MemoryConfig } from "./config.ts"
import type { MemoryGateway } from "./gateway.ts"
import type { MemoryScope, MemoryKind, MemoryStatus } from "./domain.ts"
import { actorRef, globalUserMemoryEligible } from "./domain.ts"

export interface ToolDeps {
  config: MemoryConfig
  gateway: MemoryGateway
  resolveScope: (ctx: { directory?: string; worktree?: string; sessionID?: string; agent?: string; userId?: string }) => Promise<MemoryScope>
}

const schema = tool.schema

function isReviewer(config: MemoryConfig, agent: string): boolean {
  return config.reviewerAgentNames.includes(agent)
}

function reviewerGuard(config: MemoryConfig, agent: string): string | null {
  if (!isReviewer(config, agent)) {
    return `memory review operations require a reviewer agent (got "${agent}"); configured reviewers: ${config.reviewerAgentNames.join(", ")}`
  }
  return null
}

export function buildTools(deps: ToolDeps): Record<string, ToolDefinition> {
  const { config, gateway, resolveScope } = deps

  const memory_context = tool({
    description:
      "Retrieve a compact context bundle of relevant shared memories for the current task. Use at the start of a substantial task, before delegating, or after compaction. Returns ranked, scope-filtered, deduplicated memories with trust levels and any unresolved contradictions. Does not dump raw search results.",
    args: {
      query: schema.string().min(1).describe("What you are about to do or need to know; the task or question."),
      kinds: schema.array(schema.string()).optional().describe("Optional filter: fact, decision, requirement, constraint, preference, procedure, lesson, incident, hypothesis, episode, artifact, relation."),
      includePending: schema.boolean().optional().describe("Include unreviewed pending memories (default false)."),
      maxItems: schema.number().int().positive().max(32).optional().describe("Max memories to return."),
      tokenBudget: schema.number().int().positive().max(8000).optional().describe("Soft token budget for the bundle."),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const bundle = await gateway.context(args.query, scope, {
        kinds: args.kinds as MemoryKind[] | undefined,
        includePending: args.includePending ?? false,
        maxItems: args.maxItems,
        tokenBudget: args.tokenBudget,
      })
      return { title: `Memory context: ${bundle.memories.length} items`, output: renderBundle(bundle) }
    },
  })

  const memory_search = tool({
    description:
      "Deliberate inspection of shared memory when memory_context did not return enough. Returns more results, optionally including pending/rejected states and evidence previews. Prefer memory_context for normal task work.",
    args: {
      query: schema.string().min(1).describe("Search query."),
      kinds: schema.array(schema.string()).optional(),
      statuses: schema.array(schema.string()).optional().describe("Filter by status: pending, approved, rejected, challenged, superseded, expired, observational."),
      includePending: schema.boolean().optional(),
      limit: schema.number().int().positive().max(100).optional(),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const bundle = await gateway.search(args.query, scope, {
        kinds: args.kinds as MemoryKind[] | undefined,
        statuses: args.statuses as MemoryStatus[] | undefined,
        includePending: args.includePending ?? false,
        limit: args.limit,
      })
      return { title: `Memory search: ${bundle.memories.length} results`, output: renderBundle(bundle) }
    },
  })

  const memory_get = tool({
    description:
      "Retrieve one memory by ID, including its provenance (supporting evidence events), review history, and any open conflicts. Use to verify where a memory came from or whether it has been challenged.",
    args: {
      memoryId: schema.string().min(1).describe("Memory ID (mem_...)."),
      includeEvidence: schema.boolean().optional().describe("Include supporting evidence event summaries (default true)."),
      includeHistory: schema.boolean().optional().describe("Include review history (default true)."),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const result = await gateway.getForScope(args.memoryId, scope, {
        includeEvidence: args.includeEvidence ?? true,
        includeHistory: args.includeHistory ?? true,
      })
      if (!result) return { title: "Not found", output: `No memory with id ${args.memoryId}.` }
      return { title: `Memory ${args.memoryId.slice(0, 12)}…`, output: renderMemory(result.record, result.evidence, result.reviews, result.conflicts) }
    },
  })

  const memory_propose = tool({
    description:
      "Propose durable memory for the current project. Project identity cannot be overridden; session/branch/component fields may only narrow it. Use for durable requirements, decisions, verified facts, reusable procedures, important lessons, or unresolved contradictions. Never store secrets, transient details, or unsupported assumptions. Only long-term memories about the user in general can later be promoted globally, through memory_approve_global and explicit user permission.",
    args: {
      kind: schema.string().describe("fact | decision | requirement | constraint | preference | procedure | lesson | incident | hypothesis | episode | artifact | relation."),
      statement: schema.string().min(1).max(4000).describe("A single atomic, self-contained proposition. Entity-centric, under 60 words preferred."),
      structuredPayload: schema.record(schema.string(), schema.unknown()).optional(),
      scope: schema.record(schema.string(), schema.unknown()).optional().describe("Optional narrowing within the current project: branch, component, environment, or current sessionId. Project/user/repository identity cannot be overridden."),
      evidence: schema.array(schema.record(schema.string(), schema.unknown())).optional().describe("Supporting evidence refs: { eventId?, filePath?, commit?, description? }."),
      confidence: schema.number().min(0).max(1).describe("0..1: how well evidence supports this claim."),
      durability: schema.string().describe("session | project | long_term."),
      validFrom: schema.string().optional(),
      validUntil: schema.string().optional(),
      tags: schema.array(schema.string()).optional(),
      reason: schema.string().optional().describe("Why this is durable knowledge."),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const actor = actorRef(isReviewer(config, context.agent) ? "reviewer" : "agent", context.agent)
      const result = await gateway.propose({
        kind: args.kind as never,
        statement: args.statement,
        structuredPayload: args.structuredPayload,
        scope: args.scope as Partial<MemoryScope>,
        evidence: args.evidence as never,
        confidence: args.confidence,
        durability: args.durability as never,
        validFrom: args.validFrom,
        validUntil: args.validUntil,
        tags: args.tags,
        reason: args.reason,
      }, actor, scope)
      const dup = result.duplicateOf ? ` (duplicate of ${result.duplicateOf})` : ""
      return {
        title: `Proposed ${result.status}${dup}`,
        output: `Memory ${result.memoryId} is now ${result.status} (trust: ${result.trustLevel}).${result.autoAccepted ? " Auto-accepted." : ""} ${result.reason}${dup}`,
      }
    },
  })

  const memory_approve_global = tool({
    description:
      "Promote one long-term, project-independent memory about the user in general to global user-profile memory. Eligible kinds are fact, preference, requirement, and constraint. This always asks whether the exact statement describes the user generally across all projects; approval cannot be delegated or remembered. Never use for project facts, architecture, policies, procedures, or lessons.",
    args: {
      memoryId: schema.string().min(1).describe("Current-project memory to promote globally."),
      rationale: schema.string().min(1).describe("Why this memory should apply across all projects."),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const existing = await gateway.getForScope(args.memoryId, scope, { includeEvidence: false, includeHistory: false })
      if (!existing) return { title: "Not found", output: "Memory is not visible in the current project." }
      if (!globalUserMemoryEligible(existing.record)) {
        return {
          title: "Not eligible for global memory",
          output: "Only long-term, project-independent facts, preferences, requirements, or constraints about the user in general may be global.",
        }
      }
      if (["rejected", "superseded", "expired"].includes(existing.record.status)) {
        return { title: "Not eligible for global memory", output: `Cannot promote ${existing.record.status} memory.` }
      }
      await context.ask({
        permission: "memory_global",
        patterns: [args.memoryId],
        always: [],
        metadata: {
          action: "Save general user-profile memory globally",
          confirmation: "Does this exact statement describe you generally, independent of any project?",
          category: "user_profile",
          memoryId: args.memoryId,
          statement: existing.record.statement,
          sourceProjectId: scope.projectId,
          rationale: args.rationale,
        },
      })
      const approver = actorRef("user", scope.userId ?? "user")
      const promoted = await gateway.promoteGlobal(args.memoryId, scope, approver, args.rationale)
      return {
        title: "Global memory approved",
        output: `Memory ${promoted.id} is now global after explicit interactive user approval.`,
      }
    },
  })

  const memory_relate = tool({
    description:
      "Create a typed relation between two known memories or entities. Persists structurally; graph traversal is not provided in the first release. Use to record dependencies, support, contradiction links, or alternatives.",
    args: {
      subjectId: schema.string().min(1).describe("Subject memory ID."),
      predicate: schema.string().describe("depends_on | supersedes | contradicts | supports | related_to | part_of | caused_by | alternative_to."),
      objectId: schema.string().min(1).describe("Object memory ID."),
      evidence: schema.array(schema.record(schema.string(), schema.unknown())).optional(),
      confidence: schema.number().min(0).max(1),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const actor = actorRef("agent", context.agent)
      const res = await gateway.relate(args.subjectId, args.predicate as never, args.objectId, args.evidence as never, args.confidence, actor, scope)
      return { title: `Relation ${res.id.slice(0, 16)}…`, output: `Linked ${args.subjectId} --${args.predicate}--> ${args.objectId}.` }
    },
  })

  const memory_challenge = tool({
    description:
      "Challenge an existing memory you believe is incorrect, outdated, too broad, ambiguous, contradicted, or unsupported. Does NOT delete the target; it marks it challenged and opens a conflict. Optionally propose a replacement. Use when current evidence conflicts with memory rather than silently overwriting it.",
    args: {
      memoryId: schema.string().min(1),
      challengeType: schema.string().describe("incorrect | outdated | scope_too_broad | ambiguous | contradicted | unsupported."),
      explanation: schema.string().min(1),
      evidence: schema.array(schema.record(schema.string(), schema.unknown())).optional(),
      proposedReplacement: schema.record(schema.string(), schema.unknown()).optional().describe("A memory_propose-shaped object to propose as replacement."),
    },
    async execute(args, context) {
      const scope = await resolveScope(context)
      const actor = actorRef("agent", context.agent)
      const res = await gateway.challenge({
        memoryId: args.memoryId,
        challengeType: args.challengeType as never,
        explanation: args.explanation,
        evidence: args.evidence as never,
        proposedReplacement: args.proposedReplacement as never,
      }, actor, scope)
      return {
        title: `Challenge ${res.conflictId.slice(0, 12)}…`,
        output: `Memory ${args.memoryId} marked challenged; conflict ${res.conflictId} opened.${res.challengeMemoryId ? ` Replacement proposed: ${res.challengeMemoryId}.` : ""}`,
      }
    },
  })

  const memory_checkpoint = tool({
    description:
      "Ask the memory system to process a meaningful session boundary now (priority extraction). Use before handing off, when a task is completed, a decision is reached, or before compaction. Does not require describing every memory; enqueues extraction of the recent evidence window.",
    args: {
      reason: schema.string().describe("task_completed | decision_reached | before_handoff | before_compaction | manual."),
      summary: schema.string().optional(),
      importantEventIds: schema.array(schema.string()).optional(),
    },
    async execute(args, context) {
      const actor = actorRef("agent", context.agent)
      const res = await gateway.checkpoint({
        reason: args.reason as never,
        summary: args.summary,
        importantEventIds: args.importantEventIds,
      }, context.sessionID, actor)
      return { title: `Checkpoint enqueued`, output: `Priority extraction enqueued (reason: ${args.reason}). ${res.enqueued ? "Queued." : "Not queued."}` }
    },
  })

  // ── Reviewer-only tools ───────────────────────────────────────────────────

  const memory_list_pending = tool({
    description:
      "[reviewer] List pending memory candidates awaiting review. Reviewer-only.",
    args: {
      limit: schema.number().int().positive().max(200).optional(),
      kind: schema.string().optional(),
    },
    async execute(args, context) {
      const guard = reviewerGuard(config, context.agent)
      if (guard) return { title: "Denied", output: guard }
      const scope = await resolveScope(context)
      const items = await gateway.listPending(scope, args.limit ?? 50, args.kind as never)
      if (!items.length) return { title: "No pending memories", output: "No pending memory candidates." }
      return { title: `${items.length} pending`, output: items.map(renderPendingItem).join("\n\n") }
    },
  })

  const memory_review = tool({
    description:
      "[reviewer] Review a pending or challenged memory: approve, reject, edit-and-approve, mark duplicate, supersede, or escalate. Records rationale. Reviewer-only. Reviewers cannot approve their own extractor output.",
    args: {
      memoryId: schema.string().min(1),
      decision: schema.string().describe("approve | reject | edit_and_approve | duplicate | supersede | escalate."),
      rationale: schema.string().min(1),
      editedStatement: schema.string().optional(),
      editedPayload: schema.record(schema.string(), schema.unknown()).optional(),
      editedScope: schema.record(schema.string(), schema.unknown()).optional(),
      duplicateOf: schema.string().optional(),
      supersededByMemoryId: schema.string().optional(),
      escalateTo: schema.string().optional().describe("human | agent"),
    },
    async execute(args, context) {
      const guard = reviewerGuard(config, context.agent)
      if (guard) return { title: "Denied", output: guard }
      const reviewer = actorRef("reviewer", context.agent)
      // Self-approval prevention: reviewer may not approve a memory they
      // extracted. The extractor actor id is "memory-worker"; reviewer agents
      // are distinct, so this is enforced structurally, but guard explicitly.
      const scope = await resolveScope(context)
      const existing = await gateway.getForScope(args.memoryId, scope, { includeEvidence: false, includeHistory: true })
      if (existing && existing.record.source.actor.id === context.agent && (args.decision === "approve" || args.decision === "edit_and_approve")) {
        return { title: "Denied", output: "Cannot approve your own extracted output; escalate to a different reviewer or human." }
      }
      const res = await gateway.review({
        memoryId: args.memoryId,
        decision: args.decision as never,
        rationale: args.rationale,
        editedStatement: args.editedStatement,
        editedPayload: args.editedPayload,
        editedScope: args.editedScope as never,
        duplicateOf: args.duplicateOf,
        supersededByMemoryId: args.supersededByMemoryId,
        escalateTo: args.escalateTo as never,
      }, reviewer, scope)
      return { title: `Review: ${res.status}`, output: `Memory ${res.memoryId} is now ${res.status}.` }
    },
  })

  const memory_supersede = tool({
    description:
      "[reviewer] Mark an existing memory superseded by a proposed replacement. The original is retained for history (not deleted) and removed from the default search index. Reviewer-only.",
    args: {
      memoryId: schema.string().min(1).describe("Memory to supersede."),
      replacement: schema.record(schema.string(), schema.unknown()).describe("A memory_propose-shaped replacement object."),
    },
    async execute(args, context) {
      const guard = reviewerGuard(config, context.agent)
      if (guard) return { title: "Denied", output: guard }
      const scope = await resolveScope(context)
      const reviewer = actorRef("reviewer", context.agent)
      const res = await gateway.supersede(args.memoryId, args.replacement as never, reviewer, scope)
      return { title: `Superseded`, output: `${args.memoryId} superseded by ${res.replacementId}.` }
    },
  })

  const memory_merge_duplicates = tool({
    description:
      "[reviewer] Merge duplicate memories into a keeper: the keeper absorbs evidence, the rest are marked superseded and removed from the index. Reviewer-only.",
    args: {
      keepId: schema.string().min(1),
      dropIds: schema.array(schema.string()).min(1),
    },
    async execute(args, context) {
      const guard = reviewerGuard(config, context.agent)
      if (guard) return { title: "Denied", output: guard }
      const reviewer = actorRef("reviewer", context.agent)
      const scope = await resolveScope(context)
      const res = await gateway.mergeDuplicates(args.keepId, args.dropIds, reviewer, scope)
      return { title: `Merged ${res.merged}`, output: `Merged ${res.merged} duplicate(s) into ${args.keepId}.` }
    },
  })

  return {
    memory_context,
    memory_search,
    memory_get,
    memory_propose,
    memory_approve_global,
    memory_relate,
    memory_challenge,
    memory_checkpoint,
    memory_list_pending,
    memory_review,
    memory_supersede,
    memory_merge_duplicates,
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

import type { MemoryContextBundle, MemoryRecord, MemoryReview, MemoryConflict } from "./domain.ts"
import type { EventRow } from "./journal.ts"

function renderBundle(bundle: MemoryContextBundle): string {
  const lines: string[] = []
  if (bundle.summary) lines.push(`# ${bundle.summary}`)
  if (bundle.memories.length === 0) {
    lines.push("No relevant established knowledge found.")
  } else {
    lines.push("", "## Relevant established knowledge")
    bundle.memories.forEach((m, i) => {
      lines.push(`${i + 1}. [${m.kind}, ${m.status}] (trust ${m.trustLevel}, conf ${m.confidence.toFixed(2)})`)
      lines.push(`   ${m.statement}`)
      const scopeParts: string[] = []
      if (m.scope.repositoryId) scopeParts.push(`repo:${m.scope.repositoryId}`)
      if (m.scope.branch) scopeParts.push(`branch:${m.scope.branch}`)
      if (m.scope.sessionId) scopeParts.push("session")
      lines.push(`   scope: ${scopeParts.join(", ") || "global"} | ev:${m.evidenceCount} | ${m.sourceType}`)
    })
  }
  if (bundle.unresolvedContradictions.length) {
    lines.push("", "## Potential conflicts")
    for (const c of bundle.unresolvedContradictions) {
      lines.push(`- ${c.conflictType} (${c.status}) involving ${c.memoryIds.length} memory(ies): ${c.memoryIds.slice(0, 3).join(", ")}`)
    }
  }
  if (bundle.relevantEpisodes.length) {
    lines.push("", "## Relevant previous episodes")
    for (const e of bundle.relevantEpisodes) {
      lines.push(`- [${e.outcome}] ${e.objective} (${e.sessionId.slice(0, 8)})`)
    }
  }
  if (bundle.truncated) lines.push("", "(truncated to fit token budget)")
  return lines.join("\n")
}

function renderMemory(record: MemoryRecord, evidence: EventRow[], reviews: MemoryReview[], conflicts: MemoryConflict[]): string {
  const lines: string[] = []
  lines.push(`# Memory ${record.id}`)
  lines.push(`kind: ${record.kind} | status: ${record.status} | trust: ${record.trustLevel} | confidence: ${record.confidence.toFixed(2)}`)
  lines.push(`durability: ${record.durability} | created: ${record.createdAt} by ${record.createdBy.id}`)
  if (record.validFrom || record.validUntil) lines.push(`valid: ${record.validFrom ?? "…"} → ${record.validUntil ?? "…"}`)
  lines.push("", "## Statement", record.statement)
  if (record.tags.length) lines.push("", "Tags: " + record.tags.join(", "))
  if (evidence.length) {
    lines.push("", "## Supporting evidence")
    for (const e of evidence.slice(0, 8)) {
      lines.push(`- [${e.event_type}] ${e.summary} (${e.id.slice(0, 12)})`)
    }
  }
  if (reviews.length) {
    lines.push("", "## Review history")
    for (const r of reviews) {
      lines.push(`- ${r.decision} by ${r.reviewer.id}: ${r.rationale}`)
    }
  }
  if (conflicts.length) {
    lines.push("", "## Open conflicts")
    for (const c of conflicts) {
      lines.push(`- ${c.conflictType} (${c.status})`)
    }
  }
  return lines.join("\n")
}

function renderPendingItem(m: MemoryRecord): string {
  const scope = m.scope.sessionId ? "session" : m.scope.repositoryId ? "repo" : "global"
  return `[${m.id.slice(0, 12)}] ${m.kind} (${m.trustLevel}, conf ${m.confidence.toFixed(2)}, ${scope})\n  ${m.statement}`
}
