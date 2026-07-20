# opencode config

Carlo's personal global configuration for [opencode](https://opencode.ai), kept versioned here. Lives at `~/.config/opencode/`.

## Contents

| Path | Description |
|------|-------------|
| `opencode.jsonc` | main config (model, default agent, schema) |
| `agent/` | custom subagents (orchestrator, coder, reviewer, guru) |
| `plugin/` | guarded bash tool with deepseek-v4-flash safety classifier |
| `package.json` | plugin dependencies |
| `pnpm-lock.yaml` | lockfile (pnpm is the package manager) |

## Bootstrap on a new machine

1. Clone into `~/.config/opencode/` (e.g. `git clone https://github.com/cavenditti/opencode-config.git ~/.config/opencode`)
2. Install the plugin dependency: `pnpm install`
3. Restart opencode so the new config is loaded.

## Safety classifier

The guarded `bash` tool in `plugin/bash.ts` overrides the built-in bash tool. It first applies deterministic hard rules, then asks `deepseek/deepseek-v4-flash` (thinking disabled, temperature 0) via OpenRouter for the final classification. It resolves the OpenRouter API key from opencode's own auth store (`~/.local/share/opencode/auth.json`), or from `OPENROUTER_API_KEY` if set. Alternatively, set `OPENCODE_SAFETY_URL` to use an external classifier service. The fail-safe verdict is `ask`. Run `pnpm install` (the plugin dependency is already declared) and restart opencode after changing the plugin or config.

## Notes

- opencode loads config once at startup; restart after any change.

## License

MIT, see [LICENSE](./LICENSE).
