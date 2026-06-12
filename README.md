# Relay

**Operations and control layer for AI coding agents.** Make agent work persistent, addressable, inspectable, and steerable across the tools you already use.

> Git records what code changed. Relay records what the agent did — tasks given, models used, context injected, retries, failures, and lessons.

You probably use Claude Code one day, Cursor or Codex the next, an LM Studio model after that. None of them remember what you decided yesterday. Relay keeps one local SQLite store of memory and run history across all of them: automatic injection via hooks in Claude Code, MCP tools in any MCP client (Claude Desktop, Cursor, Windsurf), explicit `relay context emit` everywhere else. It also dispatches tasks to local or hosted providers and records what every run did.

Single-user, local-first, source-install only. There is no team mode, no hosted component, and no npm package yet — see [What Relay is not](#what-relay-is-not-yet) before adopting.

[![Status](https://img.shields.io/badge/status-pre--release-yellow)](#status)
[![Release](https://img.shields.io/badge/last%20release-0.1.2-blue)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022-brightgreen)](#install)
[![Tests](https://img.shields.io/badge/tests-1825%20passing-brightgreen)](.github/workflows/test.yml)
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
relay setup --everything   # one-command: init + hooks + auto-extract (non-interactive)
relay verify               # end-to-end smoke (memory + recall + emit + hook + db)
relay doctor               # 10-check provider + DB + hook + auto-extract health
relay --help               # full menu
```

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough.

### One-command setup

`relay setup --everything` runs:

1. `relay init --auto` — detects installed LLM CLIs (Codex, LM Studio, OpenRouter, Anthropic), wires each automatically.
2. `relay memory hook --install --global` — `SessionStart` context-emit hook into `~/.claude/settings.json`.
3. `relay memory hook --install --session-end --global` — `SessionEnd` auto-extract hook (consent-gated).
4. `relay memory auto-extract --enable` — opt IN per workdir (writes `<cwd>/.relay/auto-extract.json`).

Add `--clean` to remove duplicate Relay-managed hooks before reinstalling. Add `--interactive` to re-enable prompts.

`relay init` alone (interactive) is still available for guided setup.

## Core commands

### Memory
| Command | What it does |
|---|---|
| `relay memory remember <content>` | Save fact / decision / lesson with tags, pinned flag, expiry. |
| `relay memory recall [<query>]` | FTS5 + recency-fallback recall with token budget. |
| `relay memory search <regex>` | Exact regex content search (companion to FTS-scored recall). |
| `relay memory recent [--limit N]` | List most recently created memories. |
| `relay memory show-context <query>` | Preview the `recalled_lessons` context layer. |
| `relay memory get <memory_id>` | Inspect one entry. |
| `relay memory why <memory_id>` | Explain a memory's score breakdown + last 5 surfacings. |
| `relay memory diff <id1> <id2>` | Unified line-diff of two memories' content. |
| `relay memory chain <memory_id>` | Walk the `superseded_by` provenance chain (both directions). |
| `relay memory tag-stats` | Per-tag analytics (count, recalls, last used). |
| `relay memory consolidate` | Dedup + supersede stale entries. |
| `relay memory rollback <run-id>` | Remove auto-extracted memories from a run. |
| `relay memory forget <memory_id>` | Forget one entry (soft or `--hard`). |
| `relay memory wipe --workdir <path>` | GDPR-style per-project memory wipe. |
| `relay memory to-rules <memory_id>` | Promote memory to `.claude/CLAUDE.md`. |
| `relay memory hook --install \| --uninstall` | Wire (or remove) the CC `SessionStart` / `SessionEnd` hook. |
| `relay memory auto-extract --enable` | Opt IN to SessionEnd auto-extraction (per workdir). |
| `relay memory tail [--filter <event>]` | Tail the relay activity log. |

### Cross-LLM context injection
| Command | What it does |
|---|---|
| `relay context emit --target <cc\|codex\|lmstudio-http\|lmstudio-cli>` | Emit recalled memories in per-LLM wrapper format (replaces hook jq pipeline). Defaults `--min-trust=provisional` to block unverified leaks. |

### MCP server
| Command | What it does |
|---|---|
| `relay mcp serve` | Serve memory tools over MCP stdio for Claude Desktop, Cursor, Windsurf, Zed — `relay_recall`, `relay_remember` (trust-quarantined), `relay_memory_search`, `relay_get_memory`, `relay_corpus_query`, `relay_browse_runs`, `relay_compare_runs`, plus the `relay-context` one-tap prompt. See [docs/mcp.md](docs/mcp.md). |
| `relay mcp serve --selfcheck` | In-process handshake + tools/list verification, exit 0/1. |

### Delegation
| Command | What it does |
|---|---|
| `relay run <task>` | Delegate one task to codex / lmstudio / openrouter / anthropic. |
| `relay parallel <spec.json>` | Dispatch N tasks concurrently with bounded concurrency. |
| `relay history` | Browse past runs. |
| `relay diff <run_id>` | Show files_changed + diffs for a run. |
| `relay compare <run_a> <run_b>` | Side-by-side diff of two runs. |

### Diagnostics
| Command | What it does |
|---|---|
| `relay doctor` | Probe provider + DB health (10 checks: providers, hooks, env, recall, auto-extract, berry, lmstudio model, consent files). |
| `relay verify` | End-to-end smoke (memory + recall + context emit + hook + db). |
| `relay info` | Status summary (binary, db size, type counts, 24h activity, hooks, providers). |
| `relay tui` | Command Central — terminal Ink operator console over the control layer: session rail, live event stream, and a `:` command palette routed through the broker (q to quit). |

### Setup / install
| Command | What it does |
|---|---|
| `relay init [--auto]` | Interactive setup wizard; auto-wires detected LLM CLIs. |
| `relay setup --everything [--clean] [--interactive]` | One-command installer (init + hooks + auto-extract). |
| `relay setup-llm <codex\|lmstudio\|openrouter\|anthropic>` | Per-LLM init helper. |
| `relay update [--check\|--apply]` | Self-update from source. |
| `relay completion <bash\|zsh\|fish>` | Emit shell completion script. |

### Privacy
| Command | What it does |
|---|---|
| `relay project disable\|enable\|audit` | Per-project opt-out via `.relayignore`. |
| `relay export --safe [--format json\|md\|html]` | Sanitized export (default-excludes auto-extract + private + unverified). |
| `relay pause [--minutes N]` / `relay resume` | Off-switch via sentinel file. |

Full flag reference: [docs/commands.md](docs/commands.md). Cheat sheet: [docs/cli-cheatsheet.md](docs/cli-cheatsheet.md).

## Per-LLM recipes

Worked examples for common workflows live under [docs/recipes/](docs/recipes/):

- [Migrating Claude Code memory](docs/recipes/migrating-cc-memory.md) — port existing CC auto-memory into the SQLite store.
- [Morning startup](docs/recipes/morning-startup.md) — daily `relay doctor` + recall flow.
- [Parallel dispatch with LM Studio](docs/recipes/parallel-with-lmstudio.md) — concurrency rules and worktree isolation.
- [QMD companion](docs/recipes/qmd-companion.md) — pairing Relay with the QMD planner.

## What Relay does

The operator layer around AI coding agents. Five concerns:

- **Persistent memory** — recall accumulated decisions, lessons, and contradictions across tools. Automatic injection exists for Claude Code only (`SessionStart` hook); MCP clients get model-invoked tools plus a one-tap `relay-context` prompt; everything else needs an explicit `relay context emit`.
- **Multi-model dispatch** — send a task to Codex CLI, OpenRouter, Anthropic, or a local LM Studio model (qwen, gemma, glm). One worker or many in parallel. Local-mode = zero API cost.
- **Audit + provenance** — every run records the task, model, provider, injected context, tool calls, diffs, retries, and outcome. Searchable history that survives session boundaries.
- **Steerable agentic execution** — `relay run --provider lmstudio-agentic` runs a real tool-call loop on a local model with shell access, sandboxed env, network blocklist, hash-based loop detection.
- **Cross-session control** — one command surface over every session: `relay session list / inspect / tail / send / delegate / spawn`. Relay owns the processes it launches with `relay session spawn`, so those get live stdin control and interrupt; ambient Claude Code sessions (via hooks) and transcript-backed API providers get observe plus queued delivery. Each adapter declares its real capabilities and commands refuse what an adapter can't do — Relay never claims a live channel it doesn't have. Agent-initiated cross-session traffic runs through grants, budgets, and loop detection so one model can't drive another unsupervised.

Hallucination check via optional [Berry](https://github.com/anthropics/berry) MCP integration. Model-agnostic. Single SQLite store. Works against any combination of paid + local providers.

## What Relay is not (yet)

Honest constraints, so nobody adopts on a wrong assumption:

- **Not on npm.** Source install only; MCP client configs need absolute paths until a release is cut.
- **Not multi-user.** One person, one machine, one SQLite file. No sync, no sharing, no server.
- **Not ambient outside Claude Code.** MCP tools are *model-invoked* — the model calls `relay_recall` when it decides to, not automatically every session. Only the Claude Code hook injects context unprompted.
- **Semantic recall is conditional.** Embedding-based recall requires LM Studio running locally with an embedding model loaded; otherwise recall silently falls back to word-overlap scoring, which misses paraphrases.
- **Not a release.** `0.2.0` was never cut; the last release is `0.1.2` (2026-05-11) and everything since lives on `main` unreleased.
- **Not unique.** Memory layers for LLM tools exist elsewhere (including free, hosted ones). Relay's bet is the combination: local-first ownership, trust-tiered quarantine of machine writes, score explainability (`relay memory why`), rollback, per-project wipe, and a full read/write audit trail in one place.

## Privacy & security

Local storage by default. All memory lives in a single SQLite file under `~/.relay/relay.db` (configurable via `RELAY_DB_PATH`); nothing leaves your machine unless you explicitly delegate a run to a hosted provider. Memory writes are scoped to per-project workdirs and gated by an optional `RELAY_MEMORY_ALLOWED_WORKDIRS` allowlist. The `recalled_lessons` context layer only injects entries you have explicitly remembered or migrated; opt-in via `RELAY_RECALLED_LESSONS=1`. Provider API keys live in environment variables only — never in the SQLite store, never logged. Worktree isolation for parallel dispatch keeps concurrent workers from clobbering each other's filesystem state. `shell_exec` strips secret-shaped env vars (`*KEY/*TOKEN/*SECRET/*PASSWORD`) and blocks outbound network binaries (`curl`, `wget`, `ssh`, etc.) before the local model gets a shell. See [SECURITY.md](SECURITY.md) for the full threat model.

## Status

Last release: `0.1.2` (2026-05-11). Everything below lives on `main`, unreleased. **1825 tests**, CI on Node 20 + 22 on every push.

## On main (unreleased)

- **MCP server** — `relay mcp serve` exposes the memory store to Claude Desktop, Cursor, Windsurf, Zed. Seven tools + a one-tap context prompt; MCP writes enter trust-quarantined. See [docs/mcp.md](docs/mcp.md).
- **Cross-session control layer** — `relay session list / inspect / tail / send / delegate / spawn` over registered sessions, with grants, budgets, and loop detection for agent-initiated traffic. Each adapter declares its real capabilities; commands refuse what an adapter can't do. Live stdin control exists only for processes relay itself spawns — full-TTY CLIs (claude, codex) get observe + queued delivery, not live control.
- **Command Central** — `relay tui`, a terminal Ink console over the same broker as the CLI: session rail, event stream with human/model badges, `:` command palette. A model can request a grant but can never approve its own.
- **Agentic local execution** — `relay run --provider lmstudio-agentic` runs multi-iteration tool loops on local LM Studio models. No API key, no cost; quality depends entirely on the local model.
- **Semantic recall** — by meaning via a local embedding model when LM Studio is running; word-overlap fallback otherwise.
- **Conflict detection** — contradictory memories surface as `⚠ CONFLICTS WITH #N` at recall.
- **Delta extraction** — auto-extract diffs against existing memories instead of re-extracting; contradictions flagged.
- **Figma REST tools** — two tools (`figma_list_layers`, `figma_update_token`) usable from the agentic runner. Narrow by design.

Direction beyond this lives in [ROADMAP.md](ROADMAP.md) — intentions, not promises.

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
- [Cookbook](docs/cookbook.md) — verified per-LLM recipes (CC, Codex, LM Studio, OpenRouter, Anthropic, multi-LLM).
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
