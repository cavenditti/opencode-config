/**
 * plugin/memory/git.ts — capture repository context for scope and provenance.
 *
 * Deterministic, local, bounded. Used by the event hook to attach repo/branch/
 * commit metadata to evidence, and by the gateway to resolve the current
 * scope. Never blocks interactive execution: every call has a tight timeout
 * and fails open to an empty context.
 */
import type { RepositoryContext } from "./domain.ts"

const TIMEOUT_MS = 2500

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    controller.signal.addEventListener("abort", () => proc.kill(), { once: true })
    try {
      const [stdout] = await Promise.all([new Response(proc.stdout).text()])
      await proc.exited
      clearTimeout(timer)
      return stdout.trim() || null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

export async function captureGitState(cwd: string): Promise<RepositoryContext | undefined> {
  const [remote, branch, commit, status] = await Promise.all([
    git(["config", "--get", "remote.origin.url"], cwd),
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["rev-parse", "HEAD"], cwd),
    git(["status", "--porcelain"], cwd),
  ])
  if (!commit && !remote) return undefined
  return {
    root: cwd,
    remote: remote ?? undefined,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    commit: commit ?? undefined,
    dirty: status ? status.length > 0 : undefined,
  }
}

export function repositoryId(ctx: RepositoryContext): string | undefined {
  if (ctx.remote) {
    const m = ctx.remote.match(/[:/]([^/:]+\/[^/.]+)(?:\.git)?$/)
    if (m) return m[1].toLowerCase()
    return ctx.remote
  }
  if (ctx.root) return ctx.root
  return undefined
}
