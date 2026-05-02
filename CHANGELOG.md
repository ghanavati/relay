# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for 0.2.0
- `relay run <task>` — single-task delegation to codex / lmstudio / openrouter workers
- `relay parallel <spec>` — parallel dispatch with isolation:worktree
- `relay history` — browse past runs
- `relay diff <run_id>` — show filesystem diff for a run
- `relay compare <run_a> <run_b>` — compare two runs side-by-side
- `relay init` — interactive setup wizard
- `relay doctor` — provider health probe
- `relay budget set/show` — per-provider monthly cap
- Anthropic worker (text-only first, tool-loop later)
- Per-provider `~/.relay/secrets` keystore
- npm publish to public registry

## [0.1.0] - 2026-05-02

Initial extract from the relay-mcp monorepo. Solo CLI distro focused on memory + delegation infrastructure. Dropped ~60% of relay-mcp scope (compliance, hosted, multi-tenant, regulatory reports) for a single-user surface.

### Added
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
- v0.1.0 has memory commands only — `relay run` not yet implemented (returns exit 64)
- Tests carried over from relay-mcp not all passing yet (cleanup planned in 0.2.0)
- `relay memory hook` HOOK_SCRIPT references `relay-mcp recall` (will be patched to `relay memory recall` in 0.2.0)

[Unreleased]: https://github.com/ghanavati/relay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ghanavati/relay/releases/tag/v0.1.0