/**
 * plugin/memory/capture.ts — deterministic opencode-event → evidence mapping.
 *
 * The plugin's `event` hook calls into here. This module is deliberately
 * thin and synchronous: normalize metadata, redact, generate a stable event
 * id, and hand back an EvidenceEvent (or null to skip). No LLM, no backend,
 * no ranking. Recursion prevention is enforced by capture policy: extractor
 * and reviewer origins are not extraction-eligible.
 */
import type { Event } from "@opencode-ai/sdk"
import type { EvidenceEvent, EvidenceEventType, ActorReference, Origin, RepositoryContext, MemoryScope } from "./domain.ts"
import { eventId } from "./domain.ts"
import { redactPayload, classifySensitivity, capturePolicyFor } from "./redaction.ts"

export interface CaptureCtx {
  instanceId: string
  projectId?: string
  gitCtx?: RepositoryContext
}

const MAX_PAYLOAD_CHARS = 6000
const MAX_OUTPUT_CHARS = 3000

function truncate(s: unknown, max: number): string {
  if (s == null) return ""
  const str = typeof s === "string" ? s : JSON.stringify(s)
  return str.length > max ? str.slice(0, max) + "…[truncated]" : str
}

function makeEvent(
  ctx: CaptureCtx,
  sessionId: string,
  type: EvidenceEventType,
  sourceId: string,
  summary: string,
  payload: Record<string, unknown> | null,
  origin: Origin,
  actor: ActorReference,
  revision = 0,
): EvidenceEvent {
  const redacted = payload ? redactPayload(payload) : { payload: null, result: { applied: false, fieldCount: 0, patterns: [] } }
  const sensitivity = classifySensitivity(redacted.payload)
  const capturePolicy = capturePolicyFor(type, origin, sensitivity)
  const seq = 0 // sequence assigned by journal.append via nextSequence; placeholder
  return {
    id: eventId(ctx.instanceId, sessionId, type, sourceId, revision),
    schemaVersion: 1,
    instanceId: ctx.instanceId,
    projectId: ctx.projectId,
    sessionId,
    sequence: seq,
    type,
    timestamp: new Date().toISOString(),
    actor,
    origin,
    repository: ctx.gitCtx,
    summary: truncate(summary, 400),
    payload: redacted.payload as Record<string, unknown> | undefined,
    sensitivity,
    redaction: redacted.result,
    capturePolicy,
  }
}

/** Map an opencode bus event to an evidence event. Returns null to skip.
 *  fallbackSessionId is used for events that carry no sessionID of their own
 *  (e.g. file.edited, file.watcher.updated) — attributed to the last active session. */
export function captureFromEvent(ev: Event, ctx: CaptureCtx, fallbackSessionId?: string): EvidenceEvent | null {
  const e = ev as { type: string; properties: Record<string, unknown> }
  const t = e.type
  const p = e.properties ?? {}
  const sessionId =
    (p.sessionID as string) ??
    (p.info as { id?: string } | undefined)?.id ??
    (p.part as { sessionID?: string } | undefined)?.sessionID ??
    fallbackSessionId ??
    ""
  if (!sessionId) return null

  switch (t) {
    case "session.created": {
      const info = p.info as { id: string; title?: string; directory?: string }
      return makeEvent(ctx, info.id, "session.started", info.id, `session started: ${info.title ?? info.id}`, { title: info.title, directory: info.directory }, "system", { kind: "system", id: "opencode" })
    }
    case "session.idle":
      return makeEvent(ctx, sessionId, "session.idle", sessionId, "session idle", null, "system", { kind: "system", id: "opencode" })
    case "session.compacted":
      return makeEvent(ctx, sessionId, "session.compacted", sessionId, "session compacted", null, "system", { kind: "system", id: "opencode" })
    case "session.error": {
      const err = p.error as { name?: string; data?: { message?: string } } | undefined
      const msg = err?.data?.message ?? err?.name ?? "session error"
      return makeEvent(ctx, sessionId, "session.failed", sessionId, `session failed: ${msg}`, { error: msg }, "system", { kind: "system", id: "opencode" })
    }
    case "message.updated": {
      const info = p.info as { id: string; role: string; time?: { completed?: number }; summary?: { title?: string; body?: string } }
      if (info.role === "user") {
        return makeEvent(ctx, sessionId, "message.user", info.id, `user: ${info.summary?.title ?? "(message)"}`, { messageId: info.id }, "interactive_agent", { kind: "user", id: "user" })
      }
      if (info.role === "assistant" && info.time?.completed) {
        return makeEvent(ctx, sessionId, "message.agent", info.id, `agent: ${info.summary?.title ?? "(response)"}`, { messageId: info.id, modelId: (info as { modelID?: string }).modelID }, "interactive_agent", { kind: "agent", id: "assistant" })
      }
      return null
    }
    case "message.part.updated": {
      const part = p.part as {
        id: string; type: string; sessionID: string
        tool?: string; callID?: string; state?: { status: string; input?: unknown; output?: string; title?: string; error?: string; time?: { start?: number; end?: number } }
        text?: string; synthetic?: boolean; agent?: string; prompt?: string; description?: string
      } | undefined
      if (!part) return null
      if (part.type === "tool" && part.state) {
        const st = part.state
        if (st.status === "completed") {
          return makeEvent(ctx, sessionId, "tool.after", part.id, `tool ${part.tool} completed: ${st.title ?? ""}`, {
            tool: part.tool, callID: part.callID, input: st.input, output: truncate(st.output, MAX_OUTPUT_CHARS),
            durationMs: st.time?.start && st.time?.end ? st.time.end - st.time.start : undefined,
          }, "interactive_agent", { kind: "agent", id: "assistant" })
        }
        if (st.status === "error") {
          return makeEvent(ctx, sessionId, "tool.error", part.id, `tool ${part.tool} error: ${truncate(st.error, 200)}`, {
            tool: part.tool, callID: part.callID, input: st.input, error: truncate(st.error, 500),
          }, "interactive_agent", { kind: "agent", id: "assistant" })
        }
        return null
      }
      if ((part.type === "subtask" || part.type === "agent") && part.agent) {
        return makeEvent(ctx, sessionId, "agent.delegated", part.id, `delegated to ${part.agent}: ${truncate(part.description ?? part.prompt, 120)}`, {
          agent: part.agent, prompt: truncate(part.prompt, 500),
        }, "interactive_agent", { kind: "agent", id: "assistant" })
      }
      return null
    }
    case "file.edited": {
      const file = p.file as string
      return makeEvent(ctx, sessionId, "file.changed", `edit:${file}:${sessionId}`, `file edited: ${file}`, { path: file }, "system", { kind: "system", id: "opencode" })
    }
    case "file.watcher.updated": {
      const file = p.file as string
      const evt = p.event as "add" | "change" | "unlink"
      const type: EvidenceEventType = evt === "unlink" ? "file.deleted" : "file.changed"
      return makeEvent(ctx, sessionId, type, `watch:${file}:${evt}:${sessionId}`, `file ${evt}: ${file}`, { path: file, event: evt }, "system", { kind: "system", id: "opencode" })
    }
    case "vcs.branch.updated": {
      const branch = p.branch as string | undefined
      return makeEvent(ctx, sessionId, "git.state", `vcs:${sessionId}:${branch ?? "?"}`, `branch: ${branch ?? "(unknown)"}`, { branch }, "system", { kind: "system", id: "opencode" })
    }
    case "command.executed": {
      const name = p.name as string
      const args = p.arguments as string
      return makeEvent(ctx, sessionId, "command.executed", `cmd:${p.messageID ?? name}`, `command: ${name} ${truncate(args, 200)}`, { name, arguments: truncate(args, 1000) }, "interactive_agent", { kind: "agent", id: "assistant" })
    }
    case "permission.updated": {
      const perm = p as { id: string; type: string; title: string; pattern?: string | string[]; metadata?: Record<string, unknown> }
      return makeEvent(ctx, sessionId, "permission.requested", perm.id, `permission requested: ${perm.title}`, { type: perm.type, pattern: perm.pattern }, "system", { kind: "system", id: "opencode" })
    }
    case "permission.replied": {
      const pid = (p as { permissionID: string }).permissionID
      const response = (p as { response: string }).response
      return makeEvent(ctx, sessionId, "permission.resolved", pid, `permission ${response}`, { response }, "system", { kind: "system", id: "opencode" })
    }
    case "todo.updated": {
      const todos = p.todos as { content: string; status: string; priority: string; id: string }[]
      return makeEvent(ctx, sessionId, "todo.updated", `todo:${sessionId}`, `${todos.length} todos`, { count: todos.length, items: todos.slice(0, 20) }, "interactive_agent", { kind: "agent", id: "assistant" })
    }
    default:
      return null
  }
}

/** Detect a git commit in a bash tool.after for the commit trigger. */
export function isGitCommitCommand(command: string): boolean {
  return /^git\s+commit\b/.test(command.trim())
}
