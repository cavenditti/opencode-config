# Editor conventions

Editor: Helix (selection-first, Kakoune-style). Prefer whole-file edits or morph_edit. Do not suggest Neovim-specific commands (`:help`, `:lua`, lazy.nvim, mason.nvim). Config lives in `~/.config/helix/` (`config.toml`, `languages.toml`). Helix has no IPC server yet — do not propose driving the editor programmatically; integration with opencode happens at the tmux-pane level.