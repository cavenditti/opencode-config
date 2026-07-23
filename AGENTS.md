# Editor conventions

Editor: Helix (selection-first, Kakoune-style). Prefer whole-file edits or morph_edit. Do not suggest Neovim-specific commands (`:help`, `:lua`, lazy.nvim, mason.nvim). Config lives in `~/.config/helix/` (`config.toml`, `languages.toml`). Helix has no IPC server yet — do not propose driving the editor programmatically; integration with opencode happens at the tmux-pane level.

## Web tooling agent routing

The orchestrator exposes `researcher` and `browser-reader` routinely for documentation and rendered-page reading. Delegate `browser-operator`, `web-debugger`, `crawler`, and `toolsmith` explicitly only when their specialized capabilities are needed. For library/API questions: inspect project versions → query Context7 → fall back to `webfetch` on official docs → inspect upstream source if still ambiguous.