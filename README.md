# opencode config

Carlo's personal global configuration for [opencode](https://opencode.ai), kept versioned here. Lives at `~/.config/opencode/`.

## Contents

| Path | Description |
|------|-------------|
| `opencode.jsonc` | main config (model, default agent, schema) |
| `agent/` | custom subagents (orchestrator, mid, junior, reviewer, guru) |
| `package.json` | plugin dependencies |
| `bun.lock` | lockfile (bun is the package manager) |

## Bootstrap on a new machine

1. Clone into `~/.config/opencode/` (e.g. `git clone <repo-url> ~/.config/opencode`)
2. Install the plugin dependency: `bun install` (or `npm install`)
3. Restart opencode so the new config is loaded.

## Notes

- opencode loads config once at startup; restart after any change.

## License

MIT, see [LICENSE](./LICENSE).
