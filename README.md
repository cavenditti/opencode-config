# opencode config

Carlo's personal global configuration for [opencode](https://opencode.ai), kept versioned here. Lives at `~/.config/opencode/`.

## Contents

| Path | Description |
|------|-------------|
| `opencode.jsonc` | main config (model, default agent, schema) |
| `agent/` | custom subagents (orchestrator, coder, reviewer, guru, researcher, browser-reader, browser-operator, web-debugger, crawler, toolsmith) |
| `plugin/` | guarded bash tool: deterministic checks + DS4-flash classifier with GLM-5.2 deny-escalation; `plugin/bash.ts` permission integration |
| `package.json` | plugin dependencies |
| `pnpm-lock.yaml` | lockfile (pnpm is the package manager) |

## Bootstrap on a new machine

1. Clone into `~/.config/opencode/` (e.g. `git clone https://github.com/cavenditti/opencode-config.git ~/.config/opencode`)
2. Install the plugin dependency: `pnpm install`
3. Restart opencode so the new config is loaded.

## Safety classifier

The guarded `bash` tool in `plugin/bash.ts` overrides the built-in bash tool. It first applies deterministic hard rules (hard-deny of irreversible system damage and secret/credential access — these always hard-block), then a metacharacter/path gate and a safe-command allowlist, then asks `deepseek/deepseek-v4-flash` (thinking disabled, temperature 0) via OpenRouter for the final classification. It resolves the OpenRouter API key from opencode's own auth store (`~/.local/share/opencode/auth.json`), or from `OPENROUTER_API_KEY` if set. Alternatively, set `OPENCODE_SAFETY_URL` to use an external classifier service. The fail-safe verdict is `ask`.

**Deny escalation (two-model):** when the DS4-flash classifier denies a command, it auto-escalates to `z-ai/glm-5.2` for a second opinion (longer 15s timeout). If GLM-5.2 allows AND neither model flagged a sensitive category (`destructive`/`irreversible`/`secret`/`credential`/`exfiltration`/`privilege`) AND GLM's risk < 50, the command runs (override). Otherwise — GLM also denies/asks, GLM is unavailable, or a sensitive category was flagged — the command escalates to the user via a **one-shot** `ask` (no permanent allowlist). LLM denials never hard-block; only the deterministic hard-deny layer throws. When `OPENCODE_SAFETY_URL` is set, external-classifier denies escalate to the user directly without a GLM call (privacy + policy coherence). Run `pnpm install` (the plugin dependency is already declared) and restart opencode after changing the plugin or config.

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
