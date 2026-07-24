/**
 * plugin/memory.ts — the opencode-memory-plugin entry point.
 *
 * Thin by design: loads config, opens the local stores, builds the gateway
 * and worker, and registers (a) the memory tools, (b) the `event` hook that
 * appends sanitized evidence to the journal without blocking, (c) a
 * `tool.execute.after` hook for git-commit detection, and (d) a worker
 * timer for asynchronous extraction. No extraction prompts, no Supermemory
 * API logic, no ranking — those live in their modules.
 *
 * Fail-open contract: a journal write failure never breaks the originating
 * opencode operation (unless strictMode is on); it falls back to a local
 * file append and increments a health counter.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, type MemoryConfig } from "./memory/config.ts"
import { openDatabases, type Databases } from "./memory/db.ts"
import { MemoryStore } from "./memory/store.ts"
import { Journal } from "./memory/journal.ts"
import { buildBackends } from "./memory/backend.ts"
import { MemoryGateway } from "./memory/gateway.ts"
import { MemoryWorker } from "./memory/worker.ts"
import { buildTools } from "./memory/tools.ts"
import { captureFromEvent, isGitCommitCommand, type CaptureCtx } from "./memory/capture.ts"
import { captureGitState, repositoryId } from "./memory/git.ts"
import type { MemoryScope, RepositoryContext } from "./memory/domain.ts"
import { actorRef } from "./memory/domain.ts"

interface Runtime {
  config: MemoryConfig
  dbs: Databases
  store: MemoryStore
  journal: Journal
  gateway: MemoryGateway
  worker: MemoryWorker
  timer: ReturnType<typeof setInterval> | null
  scopeCache: Map<string, MemoryScope>
  gitCache: Map<string, RepositoryContext | undefined>
  fallbackLog: string
  failures: number
  lastSessionId: string
}

async function initRuntime(options: Record<string, unknown> | undefined): Promise<Runtime> {
  const config = loadConfig(options)
  const dbs = openDatabases({ journalPath: config.journalPath, storePath: config.storePath, blobsDir: config.blobsDir })
  const store = new MemoryStore(dbs)
  const journal = new Journal(dbs)
  const registry = buildBackends(config, dbs, store)
  const scopeCache = new Map<string, MemoryScope>()
  const gitCache = new Map<string, RepositoryContext | undefined>()

  const resolveScope = async (sessionId: string, directory?: string): Promise<MemoryScope> => {
    const cached = scopeCache.get(sessionId)
    if (cached) return cached
    const dir = directory ?? process.cwd()
    const scope = await gatewayResolveScope(config, sessionId, dir)
    scopeCache.set(sessionId, scope)
    return scope
  }

  const gateway = new MemoryGateway(config, dbs, store, journal, registry)
  const worker = new MemoryWorker(config, dbs, store, journal, gateway, registry.primary, resolveScope, scopeCache)

  const runtime: Runtime = {
    config, dbs, store, journal, gateway, worker,
    timer: null, scopeCache, gitCache,
    fallbackLog: join(config.dataDir, "journal-fallback.log"),
    failures: 0,
    lastSessionId: "",
  }
  return runtime
}

async function gatewayResolveScope(config: MemoryConfig, sessionId: string, dir: string): Promise<MemoryScope> {
  const git = await captureGitState(dir)
  const scope: MemoryScope = {
    userId: process.env.USER ?? "default",
    sessionId,
    projectId: dir,
  }
  if (git) {
    scope.repositoryId = repositoryId(git)
    scope.repositoryRemote = git.remote
    scope.branch = git.branch
    scope.commitFrom = git.commit
  }
  return scope
}

function failOpen(rt: Runtime, label: string, error: unknown, ev?: { id: string; sessionId: string; type: string; summary: string }): void {
  rt.failures++
  if (rt.config.strictMode && ev) {
    throw error
  }
  try {
    mkdirSync(join(rt.config.dataDir), { recursive: true })
    const line = `[${new Date().toISOString()}] ${label}: ${error instanceof Error ? error.message : String(error)}${ev ? ` ev=${ev.id} session=${ev.sessionId} type=${ev.type}` : ""}\n`
    appendFileSync(rt.fallbackLog, line)
  } catch {
    // last resort: swallow
  }
}

function enforceGlobalPermission(input: { type: string }, output: { status: "ask" | "deny" | "allow" }): void {
  if (input.type === "memory_global" && output.status === "allow") output.status = "ask"
}

export default (async ({ directory, worktree, project }, options) => {
  const opts = (options ?? {}) as Record<string, unknown>
  const rt = await initRuntime(opts)
  if (!rt.config.enabled) {
    return {
      tool: buildTools({
        config: rt.config,
        gateway: rt.gateway,
        resolveScope: async (c) => rt.gateway.resolveScope({ ...c, sessionId: c.sessionID }),
      }),
      async "permission.ask"(input, output) { enforceGlobalPermission(input, output) },
    }
  }

  // Start the worker poll loop.
  rt.timer = rt.worker.start()

  // Resolve scope lazily per session, caching git context for capture.
  const ensureScope = async (sessionId: string): Promise<{ scope: MemoryScope; gitCtx: RepositoryContext | undefined; ctx: CaptureCtx }> => {
    let scope = rt.scopeCache.get(sessionId)
    let gitCtx = rt.gitCache.get(sessionId)
    if (!scope || gitCtx === undefined && !rt.gitCache.has(sessionId)) {
      scope = await rt.gateway.resolveScope({ directory, worktree: worktree ?? directory, sessionId, userId: process.env.USER })
      rt.scopeCache.set(sessionId, scope)
      gitCtx = await captureGitState(worktree ?? directory ?? process.cwd())
      rt.gitCache.set(sessionId, gitCtx)
      rt.worker.setSessionScope(sessionId, scope)
    }
    const ctx: CaptureCtx = {
      instanceId: rt.config.instanceId,
      projectId: project?.id,
      gitCtx: rt.gitCache.get(sessionId),
    }
    return { scope: scope ?? rt.scopeCache.get(sessionId)!, gitCtx: rt.gitCache.get(sessionId), ctx }
  }

  return {
    tool: buildTools({
      config: rt.config,
      gateway: rt.gateway,
      resolveScope: async (c) => {
        const { scope } = await ensureScope(c.sessionID ?? "")
        // Overlay caller-provided fields (directory/worktree) by re-resolving if needed.
        return scope
      },
    }),

    async event({ event }) {
      try {
        // Discover sessionId from the event to drive scope resolution.
        const e = event as { type: string; properties: Record<string, unknown> }
        const p = e.properties ?? {}
        const sessionId =
          (p.sessionID as string) ??
          (p.info as { id?: string } | undefined)?.id ??
          (p.part as { sessionID?: string } | undefined)?.sessionID ??
          ""
        // Track the last active session for events that carry no sessionID
        // (file.edited, file.watcher.updated).
        if (sessionId) rt.lastSessionId = sessionId
        const effectiveSessionId = sessionId || rt.lastSessionId
        if (!effectiveSessionId) return

        // Resolve capture context (caches git). Best-effort, never blocks.
        let ctx: CaptureCtx
        try {
          const resolved = await ensureScope(effectiveSessionId)
          ctx = resolved.ctx
        } catch {
          ctx = { instanceId: rt.config.instanceId, projectId: project?.id }
        }

        const evidence = captureFromEvent(event, ctx, rt.lastSessionId)
        if (!evidence) return
        if (!evidence.capturePolicy.memoryCapture) return

        // Assign sequence + append. Idempotent on event id.
        try {
          evidence.sequence = rt.journal.nextSequence(effectiveSessionId)
          evidence.sessionId = effectiveSessionId
          rt.journal.append(evidence)
          if (evidence.capturePolicy.extractionEligible) rt.journal.touchEligible(effectiveSessionId)
        } catch (error) {
          failOpen(rt, "journal.append", error, evidence)
          return
        }

        // Triggers: drive the worker on lifecycle events. Fire-and-forget.
        try {
          if (rt.config.batching.processOnIdle && (evidence.type === "session.idle")) {
            void rt.worker.trigger(effectiveSessionId, "idle", directory).catch(() => {})
          }
          if (rt.config.batching.processOnCompaction && evidence.type === "session.compacted") {
            void rt.worker.trigger(effectiveSessionId, "compaction", directory).catch(() => {})
          }
          if (evidence.type === "checkpoint.requested") {
            void rt.worker.trigger(effectiveSessionId, "checkpoint", directory).catch(() => {})
          }
          if (evidence.type === "session.started") {
            void ensureScope(effectiveSessionId).catch(() => {})
          }
        } catch {
          // trigger failures must not break the hook
        }
      } catch (error) {
        failOpen(rt, "event.hook", error)
      }
    },

    async "permission.ask"(input, output) {
      enforceGlobalPermission(input, output)
    },

    async "tool.execute.after"(input, _output) {
      try {
        if (input.tool !== "bash") return
        const args = input.args as { command?: string } | undefined
        const cmd = args?.command
        if (!cmd || !isGitCommitCommand(cmd)) return
        if (!rt.config.batching.processOnCommit) return
        void rt.worker.trigger(input.sessionID, "commit", directory).catch(() => {})
      } catch (error) {
        failOpen(rt, "tool.execute.after", error)
      }
    },

    async config(_cfg) {
      // Memory config comes from plugin options, not opencode config. No-op.
    },

    async dispose() {
      try { if (rt.timer) clearInterval(rt.timer) } catch {}
      try { rt.dbs.close() } catch {}
    },
  }
}) satisfies Plugin
