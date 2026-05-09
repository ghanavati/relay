# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `relay completion <bash|zsh|fish>` — emit a shell completion script for the named shell. Pipe into the shell's completion location, or `eval "$(relay completion zsh)"`.
- ANSI color support across `doctor` and `history`. Honors `NO_COLOR`, `CI`, `TERM=dumb`, and stdout-not-a-TTY auto-detection. Override with `--color=always|never` flag or `RELAY_COLOR` env.
- Codex worker now injects `WorkerTask.contextPrefix` into Codex via `-c model_instructions_file=<path>` (per Codex config-reference: `instructions` is reserved, prefer `model_instructions_file`). Tempfile lives in `os.tmpdir()` keyed by `run_id`, TOML-quoted, and removed in the worker's `.finally` cleanup. Bare `task.task` remains the prompt.

### Fixed
- `relay doctor` no longer prints "All checks passed." when checks failed. Now conditional: green "All checks passed." when truly clean, red "N checks failed, M missing, K ok" on failure, gray "K ok, M missing (informational)" when only optional providers absent.
- `relay doctor --json` emits compact one-line JSON (was pretty-printed `null, 2`).
- `relay init` no longer hardcodes `-Users-ghanavati-ai-stack-Projects-relay-mcp` as the CC memory probe path. Derives `~/.claude/projects/<hash>/memory` dynamically from `io.cwd`. Now works for any user, any project.
- `relay memory to-rules` no longer appends duplicate entries when invoked twice with the same memory_id. Returns "already present" on duplicate.
- `relay history --json` emits NDJSON (one row per line) instead of a single wrapped `{runs: [...]}` object — pipe-friendly for `jq -c`.
- `cmd-history.ts:48` removed double `.padEnd(28).slice(0,28).padEnd(28)` no-op chain. Removed `as any[]` cast — defines `RunRow` interface.
- `cmd-history.ts` `formatDuration` no longer declares unused `ms` variable; uses `<1000ms` short-form.

### Beyond v0.2 (planned)
- v0.3.0: TUI visual layer (Ink) for history + live run progress + cost dashboard
- v0.4.0: skill packs (slim), `relay run --pipe`, `relay queue cron`, `relay watch <dir>`, brew formula
- v1.0.0: stable surface, public if not already

## [0.1.0] - 2026-05-02

Initial extract from the relay-mcp monorepo. Solo CLI distro focused on memory + delegation infrastructure. Dropped ~60% of relay-mcp scope (compliance, hosted, multi-tenant, regulatory reports) for a single-user surface.

### Added
- `relay run <task>` — single-task delegation to codex / lmstudio / openrouter / **anthropic**, with audit-trail run row + run-events captured to SQLite.
- `relay parallel <spec.json>` — dispatch N tasks concurrently with bounded concurrency. JSON spec format documented in docs/recipes/parallel-with-lmstudio.md. Defaults: `--max-concurrency 4`.
- AnthropicRunner — slim Messages API runner, text-only (no tool-loop). For Claude with tool-use, route via OpenRouter `--model anthropic/claude-...`.
- Stable test suite (360/360, verified 7/7 stability runs with `--test-concurrency=1`).
- AGPL-3.0 license
- `relay memory remember <content>` — save a fact / decision / lesson with optional tags, pinned flag, expiry
- `relay memory recall [<query>]` — FTS5 + recency-fallback recall with token budget
- `relay memory show-context <query>` — preview the recalled_lessons context layer for a query
- `relay memory get <memory_id>` — inspect one entry
- `relay memory hook --install | --uninstall` — SessionStart hook wiring for Claude Code
- `relay memory to-rules <memory_id>` — promote a memory entry to a permanent rules file
- `migrate-cc-memory.ts` script — 5-phase migration of Claude Code auto-memory into MemoryStore
- Documentation: quickstart, commands, configuration, providers, memory, parallel, troubleshooting
- AGENTS.md — slim solo-CLI rules (~3.4K vs ~48K original)
- Full memory subsystem from relay-mcp: lint, gc, upsert, trust-tier computation, FTS5 store
- Workers: CodexRunner, LmStudioRunner, OpenRouterRunner (single-shot text generation — no agentic loop in v0.1.0)
- Slim runtime: store/db.ts, run-store.ts, capability registry, budget store, context layer system

### Removed (vs relay-mcp)
- Compliance / regulatory: sign_off, validate, AIBOM, oversight, validation findings
- Hosted mode: HTTP server, auth, billing, multi-tenant
- MCP server scaffolding + adapters (no @modelcontextprotocol/sdk dep)
- Self-improve loop (was unsafe in upstream)
- Skill packs / command packs / plugin system
- Drift / retention / exception / oversight stores
- Anthropic worker (deferred to v0.2 with tool-loop reimplementation)
- 15 regulatory report generators (SR 11-7, RTS 6, IEC 62304, EU AI Act Annex IV, EBA, EIOPA, DORA, etc.)

### Known limitations
- `relay budget`, `relay corpus` commands deferred to v0.2 (BudgetStore needs per-provider scope; corpus is unused without QMD integration).

[Unreleased]: https://github.com/ghanavati/relay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ghanavati/relay/releases/tag/v0.1.0