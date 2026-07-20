import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { createHash, randomUUID } from "node:crypto"

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
const MODEL_FAST = "morph/morph-v3-fast"
const MODEL_LARGE = "morph/morph-v3-large"
const DIFF_MAX_LINES = 400

type ErrorCode =
  | "FILE_NOT_FOUND"
  | "OUTSIDE_WORKTREE"
  | "SECRET_FILE"
  | "NON_UTF8"
  | "TOO_LARGE"
  | "NO_API_KEY"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "EMPTY_OUTPUT"
  | "CONCURRENT_MODIFICATION"
  | "WRITE_FAILED"
  | "INTERNAL"

type ModelChoice = "auto" | "fast" | "large"

type FailureExtras = {
  route?: "openrouter"
  modelUsed?: string
}

function failure(code: ErrorCode, output: string, extras?: FailureExtras) {
  return {
    title: `Morph edit failed: ${code}`,
    output,
    metadata: {
      error: true as const,
      code,
      ...(extras?.route ? { route: extras.route } : {}),
      ...(extras?.modelUsed ? { modelUsed: extras.modelUsed } : {}),
    },
  }
}

function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.MORPH_TIMEOUT_MS ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000
}

function maxBytes(): number {
  const parsed = Number.parseInt(process.env.MORPH_MAX_BYTES ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000000
}

function changeRatioWarn(): number {
  const parsed = Number.parseFloat(process.env.MORPH_CHANGE_RATIO_WARN ?? "")
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.3
}

function resolveRequestedModel(arg: ModelChoice | undefined): ModelChoice {
  if (arg) return arg
  const env = process.env.MORPH_DEFAULT_MODEL?.trim().toLowerCase()
  if (env === "auto" || env === "fast" || env === "large") return env
  return "auto"
}

function isSecretPath(realTarget: string): boolean {
  const base = basename(realTarget).toLowerCase()
  return (
    base.startsWith(".env") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.startsWith("id_rsa") ||
    base.endsWith(".pfx") ||
    base.endsWith(".keystore")
  )
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

type MorphCall =
  | { ok: true; content: string }
  | { ok: false; code: "HTTP_ERROR" | "TIMEOUT" | "EMPTY_OUTPUT"; message: string }

async function callMorph(
  modelId: string,
  instructions: string,
  original: string,
  codeEdit: string,
  apiKey: string,
  context: ToolContext,
): Promise<MorphCall> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs())
  const signal = AbortSignal.any ? AbortSignal.any([controller.signal, context.abort]) : controller.signal

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: `<instruction>${instructions}</instruction>\n<code>${original}</code>\n<update>${codeEdit}</update>`,
          },
        ],
      }),
      signal,
    })

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300)
      return { ok: false, code: "HTTP_ERROR", message: `OpenRouter returned HTTP ${response.status}${body ? `: ${body}` : ""}` }
    }

    const json = await response.json()
    const content = json?.choices?.[0]?.message?.content
    if (json?.choices?.[0]?.finish_reason === "length") {
      return {
        ok: false,
        code: "HTTP_ERROR",
        message:
          "Morph response was truncated (finish_reason=length). The file may exceed the model's completion cap. Try model: \"large\" or split the edit.",
      }
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, code: "EMPTY_OUTPUT", message: "Morph returned an empty response." }
    }

    let text = content
    const trimmed = content.trim()
    if (trimmed.startsWith("```")) {
      text = trimmed.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "")
    }
    if (text.trim().length === 0) {
      return { ok: false, code: "EMPTY_OUTPUT", message: "Morph returned only a code fence with no content." }
    }
    return { ok: true, content: text }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, code: "TIMEOUT", message: `Morph request timed out after ${timeoutMs()}ms.` }
    }
    return {
      ok: false,
      code: "HTTP_ERROR",
      message: `Morph request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

type DiffRun = { kind: "differences"; stdout: string } | { kind: "none" } | { kind: "error" }

async function runDiff(argv: string[]): Promise<DiffRun> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    if (exitCode === 1) return { kind: "differences", stdout }
    if (exitCode === 0) return { kind: "none" }
    return { kind: "error" }
  } catch {
    return { kind: "error" }
  }
}

function countDiffLines(diffText: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++")) continue
    if (line.startsWith("---")) continue
    if (line.startsWith("+")) added++
    else if (line.startsWith("-")) removed++
  }
  return { added, removed }
}

function countLinesFallback(original: string, merged: string): { added: number; removed: number } {
  const remaining = new Map<string, number>()
  for (const line of original.split("\n")) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1)
  }
  let added = 0
  for (const line of merged.split("\n")) {
    const count = remaining.get(line) ?? 0
    if (count > 0) {
      remaining.set(line, count - 1)
    } else {
      added++
    }
  }
  let removed = 0
  for (const count of remaining.values()) {
    removed += count
  }
  return { added, removed }
}

export default tool({
  description:
    "Apply an edit to an EXISTING file via Morph's semantic merge (OpenRouter morph-v3). You send only the changed fragments; Morph merges them with the current file content and this tool writes the result atomically.\n\n" +
    "MARKER CONTRACT: `code_edit` contains ONLY the changed lines. Represent every unchanged region with a `// ... existing code ...` marker line — omitting the marker DELETES that code. Preserve exact indentation. Batch all edits to the same file into a single call.\n\n" +
    "ROUTING: new file → use `write`. Tiny, exact, unambiguous replacement → use `edit`/`apply_patch`. Ordinary edit to an existing file → use morph_edit (leave `model` at its default `auto`). Complex or ambiguous anchors, repeated structures, large files, or many separated edits → morph_edit with `model: \"large\"`.\n\n" +
    "RULES: existing files only (morph_edit refuses new files and directories). Worktree only (paths resolving outside the session worktree are denied).\n\n" +
    "PRIVACY: the full file contents are sent to OpenRouter for the merge. NEVER use morph_edit on secrets or credential files — secret-file patterns (.env*, *.pem, *.key, id_rsa*, *.pfx, *.keystore, …) are hard-denied.",
  args: {
    target_filepath: tool.schema
      .string()
      .min(1)
      .describe("Path of the existing file to modify (relative to the session directory, or absolute). Must be inside the worktree."),
    instructions: tool.schema
      .string()
      .min(1)
      .describe("One first-person sentence describing what the edit accomplishes (e.g. 'I am adding a null check before creating the session')."),
    code_edit: tool.schema
      .string()
      .min(1)
      .describe(
        "ONLY the changed lines. Use `// ... existing code ...` for every unchanged region — omitting the marker deletes code. Preserve exact indentation. Batch all edits to this file into one call.",
      ),
    model: tool.schema
      .enum(["auto", "fast", "large"])
      .optional()
      .describe(
        "auto (default): Fast, one retry on Large if Fast fails. large: ambiguous anchors, repeated structures, large files, many separated edits.",
      ),
  },
  async execute(args, context) {
    try {
      const resolved = isAbsolute(args.target_filepath)
        ? normalize(args.target_filepath)
        : resolve(context.directory, args.target_filepath)

      // All file I/O below MUST use realTarget (never `resolved`): writing through
      // `resolved` would replace an in-worktree symlink with a regular file while
      // the real target keeps its old content.
      let realTarget: string
      try {
        realTarget = realpathSync(resolved)
      } catch {
        return failure(
          "FILE_NOT_FOUND",
          `File not found: ${resolved}. morph_edit only edits existing files; use \`write\` for new files.`,
        )
      }

      let realRoot: string
      try {
        realRoot = realpathSync(context.worktree)
      } catch {
        return failure("INTERNAL", `Could not resolve the session worktree: ${context.worktree}`)
      }

      if (!realTarget.startsWith(realRoot + sep)) {
        return failure(
          "OUTSIDE_WORKTREE",
          `Target path resolves outside the session worktree (${realRoot}). morph_edit only edits files inside the worktree.`,
        )
      }

      if (statSync(realTarget).isDirectory()) {
        return failure("FILE_NOT_FOUND", "morph_edit only edits existing regular files; use `write` for new files")
      }

      if (isSecretPath(realTarget)) {
        return failure(
          "SECRET_FILE",
          "Target path matches a secret/credential file pattern. morph_edit refuses to send secret file contents to OpenRouter. Edit it manually or use the native `edit` tool.",
        )
      }

      const buf = readFileSync(realTarget)
      const limit = maxBytes()
      if (buf.length > limit) {
        return failure(
          "TOO_LARGE",
          `File is ${buf.length} bytes, exceeding MORPH_MAX_BYTES (${limit}). Use the native \`edit\` tool with smaller, targeted replacements.`,
        )
      }

      let original: string
      try {
        original = new TextDecoder("utf-8", { fatal: true }).decode(buf)
      } catch {
        return failure("NON_UTF8", "File is not valid UTF-8 (binary or legacy encoding). morph_edit only supports UTF-8 text files.")
      }

      // TextDecoder strips a UTF-8 BOM from `original`; detect it from the raw bytes so
      // the written file keeps the on-disk encoding (BOM, CRLF) and diffs stay noise-free.
      const hasBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      const hasCRLF = original.includes("\r\n")
      const originalOnDisk = hasBOM ? "\uFEFF" + original : original

      const sha256Before = createHash("sha256").update(buf).digest("hex")

      const apiKey = resolveOpenRouterKey()
      if (!apiKey) {
        return failure(
          "NO_API_KEY",
          "No OpenRouter API key found. Set OPENROUTER_API_KEY in the environment, or run `opencode auth login` and store an OpenRouter key (auth.json under $XDG_DATA_HOME/opencode, ~/.local/share/opencode, or ~/Library/Application Support/opencode).",
          { route: "openrouter" },
        )
      }

      const requested = resolveRequestedModel(args.model)
      let modelUsed: "fast" | "large" = requested === "large" ? "large" : "fast"
      const firstModelId = requested === "large" ? MODEL_LARGE : MODEL_FAST

      context.metadata({
        title: `Morph: merging ${basename(realTarget)} (${firstModelId})`,
        metadata: { morph: { phase: "request", route: "openrouter", model: firstModelId } },
      })

      let fallbackOccurred = false
      let fallbackReason: string | undefined
      let result = await callMorph(firstModelId, args.instructions, original, args.code_edit, apiKey, context)

      if (!result.ok && requested === "auto" && !context.abort.aborted) {
        fallbackOccurred = true
        fallbackReason = `morph-v3-fast failed (${result.code}): ${result.message}`
        modelUsed = "large"
        context.metadata({
          title: `Morph: retrying ${basename(realTarget)} (${MODEL_LARGE})`,
          metadata: { morph: { phase: "request", route: "openrouter", model: MODEL_LARGE, fallback: true } },
        })
        result = await callMorph(MODEL_LARGE, args.instructions, original, args.code_edit, apiKey, context)
      }

      if (!result.ok) {
        return failure(result.code, fallbackOccurred ? `${result.message} (after fast→large fallback)` : result.message, {
          route: "openrouter",
          modelUsed,
        })
      }

      let merged = result.content
      if (hasCRLF) merged = merged.replace(/\r?\n/g, "\r\n")
      if (hasBOM) merged = "\uFEFF" + merged

      // Preserve the original's exact trailing newline sequence.
      // Morph may drop or alter trailing newlines; restore the original's.
      const trailingBreaks = hasCRLF ? /(?:\r\n|\n)*$/ : /\n*$/
      const origTrailing = originalOnDisk.match(trailingBreaks)?.[0] ?? ""
      const mergedTrailing = merged.match(trailingBreaks)?.[0] ?? ""
      if (origTrailing !== mergedTrailing) {
        merged = merged.replace(trailingBreaks, "") + origTrailing
      }

      const encodingSuspect = merged.includes("�") && !original.includes("�")

      if (merged === originalOnDisk) {
        return {
          title: `Morph edit applied (morph-v3-${modelUsed}, +0/-0)`,
          output:
            `Morph edit applied (route=openrouter; model=morph-v3-${modelUsed}${fallbackOccurred ? `; fallback: ${fallbackReason}` : ""}).\n\n` +
            "No changes: the merged content is identical to the file on disk. Nothing was written.\n\n" +
            "Review the diff, then run the project's formatter/type-checker/tests — morph_edit bypasses opencode's formatter hooks.",
          metadata: {
            error: false,
            code: undefined,
            modelUsed,
            fallbackOccurred,
            ...(fallbackReason !== undefined ? { fallbackReason } : {}),
            route: "openrouter" as const,
            changeRatio: 0,
            rewriteSuspected: false,
            linesAdded: 0,
            linesRemoved: 0,
            bytesWritten: 0,
            sha256Before,
            diffTruncated: false,
          },
        }
      }

      const tmpDir = mkdtempSync(join(tmpdir(), "morph-edit-"))
      let diffText = ""
      let diffUnavailable = false
      let diffNoOp = false
      try {
        const origPath = join(tmpDir, "orig")
        const mergedPath = join(tmpDir, "merged")
        writeFileSync(origPath, originalOnDisk, "utf8")
        writeFileSync(mergedPath, merged, "utf8")
        const rel = relative(realRoot, realTarget)
        let run = await runDiff(["diff", "-u", "--label", `a/${rel}`, "--label", `b/${rel}`, origPath, mergedPath])
        if (run.kind === "error") {
          run = await runDiff(["git", "-c", "color.ui=false", "-c", "diff.external=", "diff", "--no-index", "--", origPath, mergedPath])
        }
        if (run.kind === "differences") {
          diffText = run.stdout
        } else if (run.kind === "none") {
          diffNoOp = true
        } else {
          diffUnavailable = true
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }

      if (diffNoOp) {
        return {
          title: `Morph edit applied (morph-v3-${modelUsed}, +0/-0)`,
          output:
            `Morph edit applied (route=openrouter; model=morph-v3-${modelUsed}${fallbackOccurred ? `; fallback: ${fallbackReason}` : ""}).\n\n` +
            "No changes: the merged content is identical to the file on disk. Nothing was written.\n\n" +
            "Review the diff, then run the project's formatter/type-checker/tests — morph_edit bypasses opencode's formatter hooks.",
          metadata: {
            error: false,
            code: undefined,
            modelUsed,
            fallbackOccurred,
            ...(fallbackReason !== undefined ? { fallbackReason } : {}),
            route: "openrouter" as const,
            changeRatio: 0,
            rewriteSuspected: false,
            linesAdded: 0,
            linesRemoved: 0,
            bytesWritten: 0,
            sha256Before,
            diffTruncated: false,
          },
        }
      }

      const { added, removed } = diffUnavailable ? countLinesFallback(originalOnDisk, merged) : countDiffLines(diffText)
      const originalLineCount = originalOnDisk.split("\n").length
      const changeRatio = (added + removed) / Math.max(originalLineCount, 1)
      const rewriteSuspected = changeRatio > changeRatioWarn()

      let currentBuf: Buffer
      try {
        currentBuf = readFileSync(realTarget)
      } catch {
        return failure(
          "CONCURRENT_MODIFICATION",
          "file was removed while Morph was merging — re-read, rebuild your code_edit, retry",
          { route: "openrouter", modelUsed },
        )
      }
      let realRecheck: string
      try {
        realRecheck = realpathSync(realTarget)
      } catch {
        return failure(
          "CONCURRENT_MODIFICATION",
          "file was removed while Morph was merging — re-read, rebuild your code_edit, retry",
          { route: "openrouter", modelUsed },
        )
      }
      if (isSecretPath(realRecheck)) {
        return failure(
          "CONCURRENT_MODIFICATION",
          "File changed on disk during the Morph call. Re-read it, rebuild your code_edit against the new content, and retry.",
          { route: "openrouter", modelUsed },
        )
      }
      if (createHash("sha256").update(currentBuf).digest("hex") !== sha256Before) {
        return failure(
          "CONCURRENT_MODIFICATION",
          "File changed on disk during the Morph call. Re-read it, rebuild your code_edit against the new content, and retry.",
          { route: "openrouter", modelUsed },
        )
      }

      const tmpPath = join(dirname(realTarget), `.morph-edit-${randomUUID()}.tmp`)
      try {
        writeFileSync(tmpPath, merged, "utf8")
        chmodSync(tmpPath, statSync(realTarget).mode & 0o777)
        renameSync(tmpPath, realTarget)
      } catch (error) {
        return failure("WRITE_FAILED", `Failed to write merged content: ${error instanceof Error ? error.message : String(error)}`, {
          route: "openrouter",
          modelUsed,
        })
      } finally {
        try {
          unlinkSync(tmpPath)
        } catch {}
      }

      const bytesWritten = Buffer.byteLength(merged, "utf8")

      let diffTruncated = false
      let diffOut = diffText
      const diffLines = diffText.split("\n")
      if (diffLines.length > DIFF_MAX_LINES) {
        diffTruncated = true
        diffOut =
          diffLines.slice(0, DIFF_MAX_LINES).join("\n") +
          `\n… diff truncated (${diffLines.length} lines total); run \`git diff\` for the full patch`
      }

      const statusParts = [`route=openrouter`, `model=morph-v3-${modelUsed}`]
      if (fallbackOccurred) statusParts.push(`fallback: ${fallbackReason}`)
      if (rewriteSuspected) {
        statusParts.push(
          `WARNING: change ratio ${changeRatio.toFixed(2)} exceeds ${changeRatioWarn()} — possible full-file rewrite; review carefully`,
        )
      }
      if (encodingSuspect) {
        statusParts.push("WARNING: merged output contains U+FFFD replacement characters not present in the original — encoding may be suspect")
      }
      if (diffUnavailable) {
        statusParts.push("diff unavailable (neither `diff` nor `git diff --no-index` succeeded) — stats only")
      }

      const body = diffUnavailable
        ? `(diff unavailable) +${added}/-${removed}, change ratio ${changeRatio.toFixed(2)}`
        : diffOut

      return {
        title: `Morph edit applied (morph-v3-${modelUsed}, +${added}/-${removed})`,
        output:
          `Morph edit applied (${statusParts.join("; ")}).\n\n` +
          `${body}\n\n` +
          "Review the diff, then run the project's formatter/type-checker/tests — morph_edit bypasses opencode's formatter hooks.",
        metadata: {
          error: false,
          code: undefined,
          modelUsed,
          fallbackOccurred,
          ...(fallbackReason !== undefined ? { fallbackReason } : {}),
          route: "openrouter" as const,
          changeRatio,
          rewriteSuspected,
          linesAdded: added,
          linesRemoved: removed,
          bytesWritten,
          sha256Before,
          diffTruncated,
          ...(encodingSuspect ? { encodingSuspect: true } : {}),
          ...(diffUnavailable ? { diffUnavailable: true } : {}),
          ...(hasCRLF ? { lineEndingsPreserved: true } : {}),
          ...(hasBOM ? { bomPreserved: true } : {}),
        },
      }
    } catch (error) {
      return failure("INTERNAL", `morph_edit failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
