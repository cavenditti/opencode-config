# Editor conventions

Editor: Helix (selection-first, Kakoune-style). Prefer whole-file edits. Do not suggest Neovim-specific commands (`:help`, `:lua`, lazy.nvim, mason.nvim). Config lives in `~/.config/helix/` (`config.toml`, `languages.toml`). Helix has no IPC server yet — do not propose driving the editor programmatically; integration with opencode happens at the tmux-pane level.

## Web tooling agent routing

The orchestrator exposes `researcher` and `browser-reader` routinely for documentation and rendered-page reading. Delegate `browser-operator`, `web-debugger`, `crawler`, and `toolsmith` explicitly only when their specialized capabilities are needed. For library/API questions: inspect project versions → query Context7 → fall back to `webfetch` on official docs → inspect upstream source if still ambiguous.

<!-- context7 -->
Use the `ctx7` CLI to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer — your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Resolve library: `npx ctx7@latest library <name> "<user's question>"` — use the official library name with proper punctuation (e.g., "Next.js" not "nextjs", "Customer.io" not "customerio", "Three.js" not "threejs")
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question)
3. Fetch docs: `npx ctx7@latest docs <libraryId> "<user's question>"` — run a separate `docs` command per distinct concept if the question spans multiple topics, unless it's about how they interact
4. Answer using the fetched documentation

You MUST call `library` first to get a valid ID unless the user provides one directly in `/org/project` format. Use the user's full question as the query — specific and detailed queries return better results than vague single words, but keep each query to a single concept unless the question is about how concepts interact; combined multi-topic queries dilute ranking and return shallow results for each topic. Do not run more than 3 commands per question. Do not include sensitive information (API keys, passwords, credentials) in queries.

For version-specific docs, use `/org/project/version` from the `library` output (e.g., `/vercel/next.js/v14.3.0`).

If a command fails with a quota error, inform the user and suggest `npx ctx7@latest login` or setting `CONTEXT7_API_KEY` env var for higher limits. Do not silently fall back to training data.
<!-- context7 -->

## Shared memory

Use shared memory selectively. The memory subsystem captures evidence automatically and lets you propose durable knowledge.

Memory is project-specific by default. Never broaden a proposal by overriding project, repository, workspace, or user identity. Global memory is exceptional: use `memory_approve_global` only after the user explicitly asks for cross-project sharing; the tool must obtain one-shot interactive approval for the exact memory.

At the start of a substantial task, call `memory_context` with a description of what you're about to do. It returns ranked, scope-filtered memories with trust levels and any unresolved contradictions.

Propose a memory (`memory_propose`) when you discover a durable:
- requirement,
- decision,
- verified fact,
- reusable procedure,
- important lesson,
- or unresolved contradiction.

Do not store:
- transient implementation details,
- unsupported assumptions,
- secrets,
- raw chain-of-thought,
- or information already represented accurately in the codebase.

When current evidence conflicts with memory, challenge the existing memory (`memory_challenge`) rather than silently overwriting or ignoring it.

Before handing off or completing a substantial task, create a memory checkpoint (`memory_checkpoint`).

Use `memory_search` for deliberate inspection when `memory_context` didn't return enough. Use `memory_get` to inspect a specific memory's provenance and review history.

Memory is scoped: repository memories don't leak into unrelated projects. Branch-scoped observations stay branch-scoped. Pending candidates are excluded from default context until reviewed.
