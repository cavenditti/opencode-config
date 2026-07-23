# opencode config

Carlo's personal global configuration for [opencode](https://opencode.ai), kept versioned here. Lives at `~/.config/opencode/`.

## Contents

| Path | Description |
|------|-------------|
| `opencode.jsonc` | main config (model, default agent, schema) |
| `agent/` | custom subagents (orchestrator, coder, reviewer, guru, researcher, browser-reader, browser-operator, web-debugger, crawler, toolsmith) |
| `plugin/` | guarded bash tool: deterministic checks + DS4-flash classifier with GLM-5.2 deny-escalation; `plugin/bash.ts` permission integration |
| `tools/` | custom tools (`morph_edit` — Morph fast-apply editor) |
| `package.json` | plugin dependencies |
| `pnpm-lock.yaml` | lockfile (pnpm is the package manager) |

## Bootstrap on a new machine

1. Clone into `~/.config/opencode/` (e.g. `git clone https://github.com/cavenditti/opencode-config.git ~/.config/opencode`)
2. Install the plugin dependency: `pnpm install`
3. Restart opencode so the new config is loaded.

## Safety classifier

The guarded `bash` tool in `plugin/bash.ts` overrides the built-in bash tool. It first applies deterministic hard rules (hard-deny of irreversible system damage and secret/credential access — these always hard-block), then a metacharacter/path gate and a safe-command allowlist, then asks `deepseek/deepseek-v4-flash` (thinking disabled, temperature 0) via OpenRouter for the final classification. It resolves the OpenRouter API key from opencode's own auth store (`~/.local/share/opencode/auth.json`), or from `OPENROUTER_API_KEY` if set. Alternatively, set `OPENCODE_SAFETY_URL` to use an external classifier service. The fail-safe verdict is `ask`.

**Deny escalation (two-model):** when the DS4-flash classifier denies a command, it auto-escalates to `z-ai/glm-5.2` for a second opinion (longer 15s timeout). If GLM-5.2 allows AND neither model flagged a sensitive category (`destructive`/`irreversible`/`secret`/`credential`/`exfiltration`/`privilege`) AND GLM's risk < 50, the command runs (override). Otherwise — GLM also denies/asks, GLM is unavailable, or a sensitive category was flagged — the command escalates to the user via a **one-shot** `ask` (no permanent allowlist). LLM denials never hard-block; only the deterministic hard-deny layer throws. When `OPENCODE_SAFETY_URL` is set, external-classifier denies escalate to the user directly without a GLM call (privacy + policy coherence). Run `pnpm install` (the plugin dependency is already declared) and restart opencode after changing the plugin or config.

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
- **Secret-file denylist**: basename matching `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.pfx`, `*.keystore` is hard-denied (`SECRET_FILE`) — content never sent to OpenRouter.
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

## Web tooling stack

Six specialist agents handle web research, browser interaction, debugging, crawling, and capability discovery. The orchestrator exposes `researcher` and `browser-reader` routinely; the others are delegated explicitly.

### Agents

| Agent | Model | Tools | Purpose |
|---|---|---|---|
| `researcher` | deepseek-v4-flash | `websearch`, `webfetch`, Context7 CLI | Documentation and information gathering |
| `browser-reader` | deepseek-v4-flash | `agent-browser` read/navigation | Rendered pages, authenticated reading, screenshots |
| `browser-operator` | deepseek-v4-flash | Full `agent-browser`, side effects gated | Forms, clicks, downloads, account interactions |
| `web-debugger` | deepseek-v4-flash | Chrome DevTools MCP | Frontend debugging and performance |
| `crawler` | deepseek-v4-flash | Firecrawl | Multi-page structured extraction |
| `toolsmith` | deepseek-v4-flash | `find-skills`, package inspection | Discover and install new capabilities |

### Permission model

The custom `bash` plugin (`plugin/bash.ts`) honors `permission.bash` granular rules from `opencode.jsonc` between its secret-deny gate and its metacharacter/classifier pipeline. The precedence ladder is:

1. **HARD_DENY** (non-overridable) — irreversible system damage
2. **SECRET_DENY** (non-overridable) — credential/secret file access
3. **PATTERN_UNSAFE guard** — compound commands (`;`, `&`, `|`, `>`, `<`, backtick, `$(`, newlines) skip pattern matching
4. **`permission.bash` patterns** — user config, last-match-wins; `"*": "ask"` means "defer to plugin pipeline"
5. **METACHARS** — shell metacharacters route to classifier
6. **PATH_GATE / SAFE_COMMANDS** — read-only allowlist
7. **LLM classifier** — deepseek-v4-flash via OpenRouter, with GLM-5.2 second-opinion escalation

To add a new granular bash rule, add a key-value pair to the `bash` object in `opencode.jsonc`. Rules are evaluated in insertion order with last-match-wins. The `"*": "ask"` catch-all must remain the first key — it means "defer unmatched commands to the plugin's SAFE_COMMANDS + classifier pipeline" and prevents opencode's internal `{"*":"allow"}` default from silently auto-approving.

### Setup

Install the external tools:

```bash
npm install -g agent-browser
agent-browser install
npx ctx7 setup --opencode
npx skills add vercel-labs/agent-browser -a opencode
```

Enable Exa search (optional, for enhanced web search):

```bash
export OPENCODE_ENABLE_EXA=1
```

Restart opencode after installing tools or changing config — the plugin's `config` hook fires once at startup.

## Notes

- opencode loads config once at startup; restart after any change.

## License

MIT, see [LICENSE](./LICENSE).
