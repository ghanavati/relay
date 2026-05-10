# Relay

Solo CLI for delegating bounded coding tasks to AI workers (Codex, OpenRouter, LM Studio, Anthropic) and carrying persistent memory across Claude Code sessions. Local-first, model-agnostic, single SQLite store. No external services required.

[![Status](https://img.shields.io/badge/status-pre--release-yellow)](#status)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](#install)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

## Install

> Not published to npm. Install from source.

```bash
git clone https://github.com/ghanavati/relay.git && cd relay
npm install && npm run build
npm link        # makes 'relay' available globally from this checkout
```

Requires Node >=20 and `better-sqlite3` (native module). On macOS install Xcode CLT first.

## Quickstart

```bash
relay init           # interactive setup: providers, hooks, memory migration
relay doctor         # probe provider + DB health
relay --help         # full menu
```

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough.

### One-command setup

`relay init` walks through:

1. Detects installed LLM CLIs (Codex, LM Studio, OpenRouter API key, Anthropic).
2. Creates `~/.relay/relay.db` and `~/.relay/config.json`.
3. Installs the Claude Code `SessionStart` hook (`relay memory hook --install`) so recalled lessons inject into every CC session.
4. Optionally migrates existing Claude Code auto-memory into the SQLite store.

Run `relay init --auto` to accept all defaults non-interactively.

## Core commands

| Command | What it does |
|---|---|
| `relay memory remember <content>` | Save a fact / decision / lesson with optional tags, pinned flag, expiry. |
| `relay memory recall [<query>]` | FTS5 + recency-fallback recall with token budget. |
| `relay memory show-context <query>` | Preview the `recalled_lessons` context layer for a query. |
| `relay memory get <memory_id>` | Inspect one entry. |
| `relay memory hook --install \| --uninstall` | Wire (or remove) the CC `SessionStart` hook. |
| `relay memory to-rules <memory_id>` | Promote a memory entry to `.claude/CLAUDE.md`. |
| `relay run <task>` | Delegate one task to codex / lmstudio / openrouter / anthropic. |
| `relay parallel <spec.json>` | Dispatch N tasks concurrently with bounded concurrency. |
| `relay history` | Browse past runs. |
| `relay diff <run_id>` | Show files_changed + diffs for a run. |
| `relay compare <run_a> <run_b>` | Side-by-side diff of two runs. |
| `relay doctor` | Probe provider + DB health. |
| `relay init` | Interactive setup wizard. |
| `relay completion <bash\|zsh\|fish>` | Emit a shell completion script. |

Full flag reference: [docs/commands.md](docs/commands.md). Cheat sheet: [docs/cli-cheatsheet.md](docs/cli-cheatsheet.md).

## Per-LLM recipes

Worked examples for common workflows live under [docs/recipes/](docs/recipes/):

- [Migrating Claude Code memory](docs/recipes/migrating-cc-memory.md) — port existing CC auto-memory into the SQLite store.
- [Morning startup](docs/recipes/morning-startup.md) — daily `relay doctor` + recall flow.
- [Parallel dispatch with LM Studio](docs/recipes/parallel-with-lmstudio.md) — concurrency rules and worktree isolation.
- [QMD companion](docs/recipes/qmd-companion.md) — pairing Relay with the QMD planner.

## What it does

- **Delegate**: dispatch coding tasks to Codex CLI, OpenRouter, LM Studio (local), or Anthropic. One worker or many in parallel.
- **Audit trail**: every run captures filesystem diff, event timeline, and worker output to a local SQLite store.
- **Memory**: persistent recall across CC sessions via `SessionStart` context-layer injection.
- **Cost control**: per-provider budget caps with alerts (BudgetStore foundation in place; CLI surface in v0.2).
- **Hallucination check**: optional Berry MCP integration to validate claims.

Model-agnostic. Single SQLite store. No external services required for solo use.

## Privacy & security

Local-first by design. All memory lives in a single SQLite file under `~/.relay/relay.db` (configurable via `RELAY_DB_PATH`); nothing leaves your machine unless you explicitly delegate a run to a hosted provider. Memory writes are scoped to per-project workdirs and gated by an optional `RELAY_MEMORY_ALLOWED_WORKDIRS` allowlist. The `recalled_lessons` context layer only injects entries you have explicitly remembered or migrated; opt-in via `RELAY_RECALLED_LESSONS=1`. Provider API keys live in environment variables only — never in the SQLite store, never logged. Worktree isolation for parallel dispatch keeps concurrent workers from clobbering each other's filesystem state. See [SECURITY.md](SECURITY.md) for the full threat model.

## Status

Pre-release `0.1.0`. Currently 360+ tests, single-writer SQLite, four worker backends shipped (Codex, LM Studio, OpenRouter, Anthropic). Stable test suite verified across 7/7 stability runs with `--test-concurrency=1`. Public surface is the memory + delegation commands listed above; `relay budget` and `relay corpus` are deferred to v0.2 (see [CHANGELOG.md](CHANGELOG.md)).

### Coming next (v0.2 candidates)

The following commands are on the roadmap and may land in a follow-up wave alongside this README; check `relay --help` for the authoritative menu in your installed version:

- `relay verify` — end-to-end smoke test that exercises the install across detected providers.
- `relay info` — print resolved config, DB path, hook status, and detected provider versions.
- `relay memory rollback <run_id>` — undo the writes from one auto-extract run.
- `relay memory consolidate` — dedupe and supersede overlapping memory clusters.
- `relay update` — self-update from the source checkout.

## Documentation

- [Quickstart](docs/quickstart.md) — install, first-run setup, memory recall, hook install.
- [Commands](docs/commands.md) — every command, every flag.
- [CLI cheatsheet](docs/cli-cheatsheet.md) — one-page reference.
- [Configuration](docs/configuration.md) — env vars, `~/.relay/config.json`, precedence rules.
- [Config schema](docs/config-schema.md) — typed shape of the config file.
- [Providers](docs/providers.md) — Codex, OpenRouter, LM Studio, Anthropic setup and quirks.
- [Memory](docs/memory.md) — memory model, trust tiers, FTS5 recall, lint/gc.
- [Parallel dispatch](docs/parallel.md) — concurrency rules, worktree isolation, spec format.
- [Architecture](docs/architecture.md) — codebase layout, data flows, invariants.
- [Recipes](docs/recipes/) — worked examples for common workflows.
- [Exit codes](docs/exit-codes.md) — what every exit code means.
- [Short flags](docs/short-flags.md) — short-form aliases for common flags.
- [Troubleshooting](docs/troubleshooting.md) — common failures and fixes.
- [Security](SECURITY.md) — threat model, secret handling, sandboxing.
- [Agents guide](AGENTS.md) — single source of truth for any AI working on this repo.

## Contributing

Pull requests welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, then [AGENTS.md](AGENTS.md) for the non-negotiable code rules (immutability, no silent error swallowing, Zod at boundaries, `RelayError` for user-facing failures). Commit format: `<type>(<scope>): <description>`. Before committing: `npm run build && npm test`.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
