# opencode config

Carlo's personal global configuration for [opencode](https://opencode.ai), kept versioned here. Lives at `~/.config/opencode/`.

## Contents

| Path | Description |
|------|-------------|
| `opencode.jsonc` | main config (model, default agent, schema) |
| `agent/` | custom subagents (orchestrator, coder, reviewer, guru) |
| `plugin/` | guarded bash tool with deepseek-v4-flash safety classifier |
| `tools/` | custom tools (`morph_edit` — Morph fast-apply editor) |
| `package.json` | plugin dependencies |
| `pnpm-lock.yaml` | lockfile (pnpm is the package manager) |

## Bootstrap on a new machine

1. Clone into `~/.config/opencode/` (e.g. `git clone https://github.com/cavenditti/opencode-config.git ~/.config/opencode`)
2. Install the plugin dependency: `pnpm install`
3. Restart opencode so the new config is loaded.

## Safety classifier

The guarded `bash` tool in `plugin/bash.ts` overrides the built-in bash tool. It first applies deterministic hard rules, then asks `deepseek/deepseek-v4-flash` (thinking disabled, temperature 0) via OpenRouter for the final classification. It resolves the OpenRouter API key from opencode's own auth store (`~/.local/share/opencode/auth.json`), or from `OPENROUTER_API_KEY` if set. Alternatively, set `OPENCODE_SAFETY_URL` to use an external classifier service. The fail-safe verdict is `ask`. Run `pnpm install` (the plugin dependency is already declared) and restart opencode after changing the plugin or config.

## Morph fast-apply edits

`morph_edit` is a custom tool wrapping Morph V3 (via OpenRouter) as a patch applicator for existing files. The reasoning model emits only the changed fragments; Morph merges them and the tool writes the result atomically with a returned unified diff.

### Routing

| Situation | Route |
|---|---|
| New file | Native `write` |
| Tiny exact replacement (one or two lines, unique anchor) | Native `edit` / `apply_patch` |
| Ordinary existing-file edit | `morph_edit` (Morph V3 Fast, `model: "auto"`) |
| Ambiguous anchors, repeated structures, large file, many separated edits | `morph_edit` with `model: "large"` (Morph V3 Large) |
| Fast produced a suspicious diff or failed validation | Retry with `model: "large"` |
| Cross-file architectural change | Parent model plans; one `morph_edit` call per file |

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | (unset) | OpenRouter API key. If unset, morph_edit resolves the key from opencode's auth store (`~/.local/share/opencode/auth.json`, etc.) — same chain as the bash safety classifier. |
| `MORPH_DEFAULT_MODEL` | `auto` | Default model routing: `fast`, `large`, or `auto` (Fast first, one retry on Large if Fast fails). |
| `MORPH_TIMEOUT_MS` | `120000` | Abort the Morph API call after this many milliseconds. |
| `MORPH_MAX_BYTES` | `1000000` | Refuse files larger than this (protects the 82K/262K context windows). |
| `MORPH_CHANGE_RATIO_WARN` | `0.30` | Flag the diff for parent review when more than this fraction of lines changes (advisory, non-blocking). |

### Error codes

| Code | Meaning |
|---|---|
| `FILE_NOT_FOUND` | The requested file does not exist on disk. |
| `OUTSIDE_WORKTREE` | Target path resolves outside the allowed worktree. |
| `SECRET_FILE` | File matched the secret-file denylist — content never sent. |
| `NON_UTF8` | File is not valid UTF-8 and cannot be edited. |
| `TOO_LARGE` | File exceeds `MORPH_MAX_BYTES`. |
| `NO_API_KEY` | No OpenRouter API key found in environment or auth store. |
| `HTTP_ERROR` | OpenRouter API returned a non-2xx status. |
| `TIMEOUT` | API call exceeded `MORPH_TIMEOUT_MS`. |
| `EMPTY_OUTPUT` | Morph returned an empty response. |
| `CONCURRENT_MODIFICATION` | File changed on disk since the read — optimistic hash mismatch. |
| `WRITE_FAILED` | The atomic write (temp file + rename) could not be completed. |
| `INTERNAL` | Unexpected internal error. |

### Validation gates

- **Worktree confinement**: target must resolve (via `realpath`) inside `context.worktree`; symlink escapes blocked.
- **Secret-file denylist**: basename matching `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_rsa.*`, `*.pfx`, `*.keystore` is hard-denied (`SECRET_FILE`) — content never sent to OpenRouter.
- **Non-empty + valid UTF-8 output.**
- **SHA-256 of original file** before the Morph call; recheck immediately before atomic write; mismatch → `CONCURRENT_MODIFICATION` (caller retries).
- **Atomic write**: same-directory temp file + `rename`.
- **Unified diff** returned to the parent model for review (truncated at 400 lines).
- **Change-ratio > `MORPH_CHANGE_RATIO_WARN`** (default 30%) flagged in metadata + output (advisory, non-blocking).
- **Fast→Large fallback** on `HTTP_ERROR` / `TIMEOUT` / `EMPTY_OUTPUT` only, single retry, `auto` model only.
- **Formatter / type-checker / tests** are the PARENT MODEL's responsibility — `morph_edit` writes via `node:fs` and bypasses opencode's formatter-on-edit hooks.

### Privacy

File contents leave the machine to OpenRouter; permission is `allow` globally (user-consented); secret files are hard-denied at the content layer regardless of permission.

### Concurrency caveat

Optimistic hash; multi-agent work on the same file should use separate git worktrees; `diff` and `git` must be on PATH (macOS/Linux; Windows unsupported).

### Install note

No new dependencies (`pnpm install` unchanged); restart opencode after the config change so the tool is loaded.

## Notes

- opencode loads config once at startup; restart after any change.

## License

MIT, see [LICENSE](./LICENSE).
