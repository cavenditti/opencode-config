# opencode config

Carlo's personal global configuration for [opencode](https://opencode.ai), kept versioned here. Lives at `~/.config/opencode/`.

## Contents

| Path | Description |
|------|-------------|
| `opencode.jsonc` | main config (model, default agent, schema) |
| `agent/` | custom subagents (orchestrator, coder, reviewer, guru, researcher, browser-reader, browser-operator, web-debugger, crawler, toolsmith) |
| `plugin/` | guarded bash/webfetch tools, English-language enforcement, shared memory, and task-result enforcement |
| `test/` | tests kept outside `plugin/` so OpenCode does not auto-load them |
| `webfetch-rules.json` | optional URL-pattern overrides for the guarded webfetch tool |
| `package.json` | plugin dependencies |
| `pnpm-lock.yaml` | lockfile (pnpm is the package manager) |

## Bootstrap on a new machine

1. Clone into `~/.config/opencode/` (e.g. `git clone https://github.com/cavenditti/opencode-config.git ~/.config/opencode`)
2. Install the plugin dependency: `pnpm install`
3. Restart opencode so the new config is loaded.

## Safety classifier

The guarded `bash` tool in `plugin/bash.ts` overrides the built-in bash tool. It first applies deterministic hard rules (hard-deny of irreversible system damage and secret/credential access — these always hard-block), then a metacharacter/path gate and a safe-command allowlist, then asks `deepseek/deepseek-v4-flash` (thinking disabled, temperature 0) via OpenRouter for the final classification. It resolves the OpenRouter API key from opencode's own auth store (`~/.local/share/opencode/auth.json`), or from `OPENROUTER_API_KEY` if set. Alternatively, set `OPENCODE_SAFETY_URL` to use an external classifier service. The fail-safe verdict requires permission and does not execute.

**Deny escalation (two-model):** when the DS4-flash classifier denies a command, it auto-escalates to `z-ai/glm-5.2` for a second opinion (longer 15s timeout). If GLM-5.2 allows AND neither model flagged a sensitive category (`destructive`/`irreversible`/`secret`/`credential`/`exfiltration`/`privilege`) AND GLM's risk < 50, the command runs (override). Otherwise — GLM also denies/asks, GLM is unavailable, or a sensitive category was flagged — the standard tool returns a structured `NOT EXECUTED` result to the calling agent. When `OPENCODE_SAFETY_URL` is set, external-classifier denies return the same result without a GLM call (privacy + policy coherence). LLM denials do not become permanent hard blocks; deterministic deny rules do.

### Deferred permission escalation

`bash` and `webfetch` never prompt the user directly. A permission-required result includes the policy reason, risk, categories, and progress toward the retry threshold. After two qualifying denials of the same protected operation in the same session, agent, and user turn, the standard tool returns a short-lived opaque `request_id`. Only then can the agent call `bash_request_permission` or `webfetch_request_permission`. The companion tool validates the token, re-runs the complete safety policy, and may issue one user prompt with no permanent allowlist. Hard-denied operations can never mint or use a token.

Tokens are one-shot, expire after ten minutes, and are invalidated by a new user message. Once a permission request is used, that operation cannot prompt again until the user sends another message. Only safety-policy denials count; command exit codes, HTTP errors, timeouts, and malformed arguments do not. Set `OPENCODE_PERMISSION_RETRY_THRESHOLD` to an integer from 2 through 5 to change the default threshold of 2.

### English-language guard

`plugin/english-guard.ts` targets GLM, DeepSeek, Qwen, Kimi/Moonshot, MiniMax, and Yi model IDs. It appends a strong English-only system rule before generation. If substantial Chinese still appears, completed assistant text is translated before it is stored, while completed reasoning parts are translated and replaced in place through OpenCode's message-part API. The translated part is what the TUI displays and what later turns receive as context. Once drift is detected, subsequent turns also receive a short English recovery instruction.

OpenCode does not expose a hook for rewriting reasoning token-by-token, so Chinese may remain visible while the reasoning part is actively streaming; replacement happens when that part completes. The guard never auto-submits a synthetic “continue in English” user turn, avoiding surprise extra generations.

Translation uses OpenRouter with `openai/gpt-4.1-mini`, falling back to `deepseek/deepseek-v4-flash`, and sends only parts with substantial Han text. Configure it with:

- `OPENCODE_ENGLISH_GUARD_MODELS`: comma-separated model-ID substrings to target.
- `OPENCODE_ENGLISH_GUARD_TRANSLATION_MODEL`: preferred translator model.
- `OPENCODE_ENGLISH_GUARD_TRANSLATE=0`: keep prevention/recovery prompts but disable translation calls.
- `OPENCODE_ENGLISH_GUARD_DEBUG=1`: log translation failures.

### Webfetch gate

`plugin/webfetch.ts` overrides the built-in `webfetch` while preserving its `url`, `format`, and `timeout` behavior. It blocks non-HTTP schemes, cloud metadata, IPv6 literals, and credential-bearing URLs; requires deferred permission for secret-looking query strings, private-network destinations, or unresolved hosts; auto-allows verified public documentation hosts; and sends other public URLs to the low-cost classifier. Every redirect is checked again. Permission-required and classifier-denied fetches return structured non-execution results through the standard tool; user prompts are available only through `webfetch_request_permission` after the retry gate opens.

URL values are redacted before classifier calls, permission metadata, and tool titles. The plugin uses OpenCode's OpenRouter credential by default. Set `OPENCODE_WEBFETCH_SAFETY_URL` for a dedicated external classifier; otherwise `OPENCODE_SAFETY_URL` is used when present. Set `OPENCODE_WEBFETCH_INCLUDE_USER_MESSAGE=0` to omit conversational context from classifier calls. The fail-safe verdict is `ask`.

Optional URL overrides live in `webfetch-rules.json`. Patterns use `*` and `?`, are evaluated in file order with last-match-wins, and cannot override the earlier scheme, cloud-metadata, IPv6, embedded-credential, or secret-query checks. The default `"*": "ask"` entry is a defer sentinel; add more-specific `allow`, `ask`, or `deny` entries after it. A deliberate rule can allow an otherwise private or DNS-unresolved destination.

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
