import { tool } from "@opencode-ai/plugin"
import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Verdict = {
  decision: "allow" | "ask" | "deny"
  risk: number
  categories: string[]
  reason: string
}

const HARD_DENY: RegExp[] = [
  /\brm\s+(-\S*\s+)*\/(?:\s|$)/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bwipefs\b/i,
  /\bdd\b.*\bof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
]

const HARD_ALLOW = /^\s*(pwd|whoami|ls(?:\s|$)|rg(?:\s|$)|git status|git diff|git log(?:\s|$))\b/i

function deterministicVerdict(command: string): Verdict | undefined {
  for (const pattern of HARD_DENY) {
    if (pattern.test(command)) {
      return {
        decision: "deny",
        risk: 100,
        categories: ["destructive-system-operation"],
        reason: "The command could irreversibly damage the host system.",
      }
    }
  }

  if (HARD_ALLOW.test(command)) {
    return {
      decision: "allow",
      risk: 5,
      categories: ["read-only"],
      reason: "Recognized read-only command.",
    }
  }

  return undefined
}

/** Resolve the OpenRouter API key.
 * Checks the environment variable first, then searches opencode's auth store.
 */
function resolveOpenRouterKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY?.trim()
  if (envKey) return envKey

  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) {
    candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  }
  const home = homedir()
  candidates.push(join(home, ".local", "share", "opencode", "auth.json"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "auth.json"))

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw)
      const key = parsed?.openrouter?.key
      if (typeof key === "string" && key.trim()) {
        return key.trim()
      }
    } catch {
      // silently ignore errors and try next candidate
    }
  }
  return undefined
}

const SYSTEM_PROMPT = `Constrained, no tools, no repo access. Output STRICT JSON only: {"decision":"allow"|"ask"|"deny","risk":0-100,"categories":["..."],"reason":"..."}. Temperature 0. Uncertain or side effects outside worktree -> ask. Never allow destructive/irreversible. Categories: filesystem mutation (esp. outside worktree), destructive/irreversible ops, privilege escalation, credential/secret/env-var access, network upload/exfiltration, git history rewrite/remote push, package install/arbitrary downloaded code, container/cloud/db/infra/production mutation, bounded rollback availability. Read-only -> allow. Do NOT include file contents; only command + cwd + worktree.`

function buildUserPrompt(command: string, ctx: ToolContext): string {
  return `Classify this shell command: ${JSON.stringify({ command, cwd: ctx.directory, worktree: ctx.worktree })}`
}

async function classify(command: string, ctx: ToolContext): Promise<Verdict> {
  if (process.env.OPENCODE_SAFETY_URL) {
    return classifyExternal(command, ctx)
  }
  return classifyOpenRouter(command, ctx)
}

async function classifyExternal(command: string, ctx: ToolContext): Promise<Verdict> {
  try {
    const response = await fetch(process.env.OPENCODE_SAFETY_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "bash",
        arguments: { command },
        cwd: ctx.directory,
        worktree: ctx.worktree,
        policy: {
          allowedDecisions: ["allow", "ask", "deny"],
          askOnUncertainty: true,
          protectOutsideWorktree: true,
          protectCredentials: true,
          protectRemoteState: true,
        },
      }),
    })

    if (!response.ok) {
      return {
        decision: "ask",
        risk: 70,
        categories: ["classifier-unavailable"],
        reason: `External classifier returned HTTP ${response.status}.`,
      }
    }

    const parsed = await response.json()
    if (!isValidVerdictShape(parsed)) {
      return {
        decision: "ask",
        risk: 70,
        categories: ["invalid-classifier-response"],
        reason: "External classifier returned an invalid response.",
      }
    }
    return normalizeVerdict(parsed)
  } catch (error) {
    return {
      decision: "ask",
      risk: 70,
      categories: ["classifier-unavailable"],
      reason: `External classifier request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function classifyOpenRouter(command: string, ctx: ToolContext): Promise<Verdict> {
  const apiKey = resolveOpenRouterKey()
  if (!apiKey) {
    return {
      decision: "ask",
      risk: 70,
      categories: ["classifier-unavailable"],
      reason: "No OpenRouter API key found in OPENROUTER_API_KEY env var or opencode auth store.",
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  const signal = AbortSignal.any ? AbortSignal.any([controller.signal, ctx.abort]) : controller.signal

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        temperature: 0,
        response_format: { type: "json_object" },
        reasoning: { enabled: false },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(command, ctx) },
        ],
      }),
      signal,
    })

    if (!response.ok) {
      return {
        decision: "ask",
        risk: 70,
        categories: ["classifier-unavailable"],
        reason: `OpenRouter returned HTTP ${response.status}.`,
      }
    }

    const json = await response.json()
    const content = typeof json?.choices?.[0]?.message?.content === "string"
      ? json.choices[0].message.content
      : ""

    const parsed = parseModelJson(content)
    if (!parsed) {
      return {
        decision: "ask",
        risk: 70,
        categories: ["invalid-classifier-response"],
        reason: "Classifier response was not valid JSON.",
      }
    }
    if (!isValidVerdictShape(parsed)) {
      return {
        decision: "ask",
        risk: 70,
        categories: ["invalid-classifier-response"],
        reason: "Classifier response had an invalid shape.",
      }
    }
    return normalizeVerdict(parsed)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        decision: "ask",
        risk: 70,
        categories: ["classifier-unavailable"],
        reason: "Safety classifier request timed out after 8 seconds.",
      }
    }
    return {
      decision: "ask",
      risk: 70,
      categories: ["classifier-unavailable"],
      reason: `Safety classifier request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseModelJson(content: string): unknown {
  let text = content.trim()
  if (text.startsWith("```")) {
    text = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim()
  }

  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return undefined
  }

  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1))
  } catch {
    return undefined
  }
}

function isValidVerdictShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const decision = obj.decision;
  const reason = obj.reason;
  if (decision !== "allow" && decision !== "ask" && decision !== "deny") return false;
  if (typeof reason !== "string" || reason.length === 0) return false;
  return true;
}

function normalizeVerdict(parsed: unknown): Verdict {
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}

  const decision = obj.decision === "allow" || obj.decision === "ask" || obj.decision === "deny"
    ? obj.decision
    : "ask"

  const rawRisk = typeof obj.risk === "number" ? obj.risk : 50
  const risk = Math.max(0, Math.min(100, rawRisk))

  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((c): c is string => typeof c === "string")
    : []

  const reason = typeof obj.reason === "string" && obj.reason.length > 0
    ? obj.reason
    : "No reason provided by classifier."

  return { decision, risk, categories, reason }
}

export default (async () => {
  return {
    tool: {
      bash: tool({
        description: "Execute a shell command after deterministic and model-based safety classification.",
        args: {
          command: tool.schema.string().min(1).describe("Shell command to execute"),
          description: tool.schema.string().optional().describe("Short human-readable summary of what the command does"),
        },
        async execute(args, context) {
          const verdict = deterministicVerdict(args.command) ?? (await classify(args.command, context))

          context.metadata({
            title: `Shell: ${verdict.decision}`,
            metadata: { safety: verdict },
          })

          if (verdict.decision === "deny") {
            throw new Error(`Blocked by safety policy: ${verdict.reason}`)
          }

          if (verdict.decision === "ask") {
            await context.ask({
              permission: "bash",
              patterns: [args.command],
              always: [args.command],
              metadata: {
                command: args.command,
                risk: verdict.risk,
                categories: verdict.categories,
                reason: verdict.reason,
              },
            })
          }

          const proc = Bun.spawn(["/bin/bash", "-lc", args.command], {
            cwd: context.directory,
            stdout: "pipe",
            stderr: "pipe",
          })

          const onAbort = () => proc.kill()
          context.abort.addEventListener("abort", onAbort, { once: true })

          try {
            const [stdout, stderr] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ])
            const exitCode = await proc.exited

            const parts: string[] = []
            const outTrim = stdout.trim()
            const errTrim = stderr.trim()
            if (outTrim) parts.push(outTrim)
            if (errTrim) parts.push(errTrim)
            const output = parts.join("\n")

            return {
              title: `Shell exited ${exitCode}`,
              output: output || `(no output, exit code ${exitCode})`,
              metadata: { exitCode, safety: verdict },
            }
          } finally {
            context.abort.removeEventListener("abort", onAbort)
          }
        },
      }),
    },
  }
}) satisfies Plugin
