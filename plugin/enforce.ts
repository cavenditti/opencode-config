/**
 * plugin/enforce.ts — defense-in-depth enforcement of the status-block + commit protocol.
 *
 * Purpose: when a subagent (the `task` tool) completes, check its result for the
 * required status-block markers and verify any reported commit SHA touches exactly
 * the paths listed in `Files:`. Append `[enforce]` warnings + metadata on mismatch.
 *
 * Fail-open contract: this plugin NEVER throws and NEVER blocks a task result.
 * Every step is wrapped in try/catch that swallows to a debug log. Unrecognizable
 * shapes are skipped silently (not warned) to bound noise.
 *
 * Fallback ladder: if `tool.execute.after` does not fire for the built-in `task`
 * tool (detect via OPENCODE_ENFORCE_DEBUG=1 — no invocations logged after a
 * subagent dispatch), the fallback is the `event` hook filtered on
 * task/session-completion event types, with shapes discovered via debug logging.
 * If no hook can observe subagent results, enforcement degrades to prompt-level
 * rules plus the reviewer's committed-paths-vs-Files cross-check (the authoritative
 * backstop). `chat.message` is NOT a viable fallback: it is typed to user-role
 * messages only.
 */
import type { Plugin } from "@opencode-ai/plugin"

const MARKERS = ["Status:", "Confidence:", "Spec issues:", "Deviations:", "Files:", "Verification:", "Commit:", "Warnings:"]
const ENFORCED = new Set(["coder", "guru"])
const GURU_EXEMPT = /^\s*Mode:\s*(ADVERSARIAL|PLAN)\b/m
const SHA_RE = /^\s*Commit:\s*([0-9a-f]{7,40})\s*$/im
const FILES_RE = /^\s*Files:\s*(.+)\s*$/im
const GIT_TIMEOUT_MS = 4000

function debug(...args: unknown[]): void {
  if (process.env.OPENCODE_ENFORCE_DEBUG === "1") {
    console.error("[enforce]", ...args)
  }
}

async function checkCommit(sha: string, files: string[], cwd: string): Promise<string[]> {
  try {
    let timedOut = false
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, GIT_TIMEOUT_MS)
    const proc = Bun.spawn(["git", "show", "--name-only", "--format=", "-1", sha], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const onAbort = () => proc.kill()
    controller.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      if (timedOut) {
        debug("git show timed out", { sha })
        return []
      }
      if (exitCode !== 0) {
        if (stderr.includes("not a git repository")) {
          return []
        }
        return [`reported commit ${sha} not found in git history`]
      }
      const committed = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const committedSet = new Set(committed)
      const filesSet = new Set(files)
      const notListed = committed.filter((path) => !filesSet.has(path))
      const notInCommit = files.filter((path) => !committedSet.has(path))
      const issues: string[] = []
      if (notListed.length > 0) {
        issues.push(`commit ${sha} contains files not listed in Files: ${notListed.join(", ")}`)
      }
      if (notInCommit.length > 0) {
        issues.push(`Files: lists paths not in commit ${sha}: ${notInCommit.join(", ")}`)
      }
      return issues
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener("abort", onAbort)
    }
  } catch (error) {
    debug("checkCommit error", error)
    return []
  }
}

export default (async ({ directory }) => {
  return {
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any },
    ) => {
      try {
        debug("hook invocation", {
          tool: input?.tool,
          outputIsString: typeof output?.output === "string",
          outputLength: typeof output?.output === "string" ? output.output.length : null,
        })
        if (input?.tool !== "task") return
        const subagent = typeof input?.args?.subagent_type === "string" ? input.args.subagent_type : null
        if (!subagent || !ENFORCED.has(subagent)) return
        const text = typeof output?.output === "string" ? output.output : null
        if (text == null) {
          debug("unrecognizable shape", { tool: input?.tool, hasOutput: typeof output?.output })
          return
        }
        if (subagent === "guru" && GURU_EXEMPT.test(text.slice(0, 300))) return
        const issues: string[] = []
        const missing = MARKERS.filter((marker) => !text.includes(marker))
        if (missing.length > 0) {
          issues.push(`missing status markers: ${missing.join(", ")}`)
        }
        const shaMatch = SHA_RE.exec(text)
        const filesMatch = FILES_RE.exec(text)
        const sha = shaMatch ? shaMatch[1] : null
        const files = filesMatch
          ? filesMatch[1]
              .split(",")
              .map((entry) => entry.trim().replace(/^[`"']+|[`"']+$/g, "").replace(/^\.\//, ""))
              .filter((entry) => entry.length > 0)
          : []
        if (sha) {
          const cwd = directory ?? process.cwd()
          const commitIssues = await checkCommit(sha, files, cwd)
          issues.push(...commitIssues)
        }
        if (issues.length === 0) {
          try {
            output.metadata = { ...(output.metadata ?? {}), enforce: { ok: true } }
          } catch (error) {
            debug("metadata mutation failed", error)
          }
        } else {
          try {
            output.metadata = { ...(output.metadata ?? {}), enforce: { ok: false, issues } }
          } catch (error) {
            debug("metadata mutation failed", error)
          }
          try {
            output.output = text + "\n\n[enforce] " + issues.join("\n[enforce] ")
          } catch (error) {
            debug("output mutation failed", error)
          }
        }
      } catch (error) {
        debug("hook error", error)
      }
    },
  }
}) satisfies Plugin
