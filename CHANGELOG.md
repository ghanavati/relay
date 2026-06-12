# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — MCP server (Phase 9)

- **`relay mcp serve`** — stdio MCP server over the existing tool handlers (restoring the surface lost in the relay-mcp extraction). Exposes `relay_recall`, `relay_memory_search`, `relay_get_memory`, `relay_corpus_query`, `relay_browse_runs`, `relay_compare_runs`, `relay_remember`, and the `relay-context` prompt to any MCP client (Claude Desktop, Cursor, Windsurf, Zed). `--selfcheck` runs an in-process handshake and exits 0/1. Setup guide: `docs/mcp.md`.
- **Workdir gate for cwd-less clients** — explicit `workdir` arg > `RELAY_MCP_DEFAULT_WORKDIR` (client `env` block) > refusal with instructions. Never a silent global fallback.
- **Write quarantine** — MCP writes enter as `memory_source='worker-mcp'` at trust `unverified`; `pinned`/`source_run_id` are not accepted over MCP (pinning jumps quarantine; source_run_id bypasses the write rate limit). MCP recall floors at `min_trust='provisional'`, so MCP-written entries cannot surface over MCP until promoted.
- **Pause sentinel honored** — `~/.relay/paused` blocks MCP recall/search/remember and the context prompt, same as hooks.
- New dependency: `@modelcontextprotocol/sdk` (PRD 09 D-01).

### Fixed — Phase 9

- **CI time bomb (red since 2026-06-09):** two control-e2e tests minted grants at a fixed epoch `T0 = 1_781_000_000_000` (2026-06-09 13:33 UTC) with a 10-minute TTL, while the LLM tool path validates expiry against the real wall clock. Every CI run on every branch failed after 2026-06-09 13:43 UTC — including docs-only commits — despite main being green on 2026-06-08. Grants in those tests are now minted at `Date.now()`. Lesson: never mint TTL'd state from a fixed epoch when the validation path reads the wall clock.
- `RunStore.list()` filtered on `runs.archived_at`, a column no DDL or migration ever created — every default (non-archived) listing threw `SQLITE_ERROR` on fresh DBs. Latent since the relay-mcp extraction because `handleBrowseRuns` was its only caller and nothing served it. Added the PRAGMA-guarded `archived_at` migration.

### Added — universal control layer (Phase 8)

- **Cross-session control surface** — `relay session list / inspect / tail / send / delegate / spawn / grant / revoke / pause / resume / approve / deny`. Any supported LLM surface registers as a control session with an explicit, declared capability set; commands refuse unsupported operations instead of silently degrading.
- **Relay-owned process sessions** — `relay session spawn --provider <name> <command...>` launches a child through node `child_process` pipes (no PTY dependency in v1). Relay tails its stdout/stderr as control events, writes to its stdin (`live_stdin`), interrupts it (SIGINT), and records stopped-state on exit. Full-TTY CLIs (claude, codex) detect non-TTY stdio, so they report `live_stdin` absent — observe and interrupt still apply. This is the one path with real live control; every other adapter is observe plus queued/transcript delivery.
- **LLM-facing control tools** — models call `relay_session_send` / `relay_inbox_read` / etc. through the same broker the CLI uses. Agent-initiated cross-session sends are default-deny: they require a human-issued grant with a TTL and a message budget, with content redaction and identical-message loop detection as guardrails.
- **Diagnostics** — `relay verify` runs a rolled-back control smoke (broker send → delivered, zero residue), `relay doctor` reports session / active / queued / blocked counts, and `relay info` adds a control rollup plus a truthful per-provider adapter capability catalog.
- **Command Central** — `relay tui` is the terminal-native Ink operator console over the control broker: a split rail (Sessions roster plus a merged inbox / grants / pending-requests Queue), a live event stream with `human` / `llm` source badges and pending → approved/denied → executed dispositions, and a single status strip. A `:` command palette runs the same broker-backed actions as `relay session ...` (send, delegate, inspect, tail, grant, revoke, pause, resume, approve, deny), defaulting to the rail's selected session. `relay tui --json` emits the same bounded `ControlSnapshot` the UI renders. Terminal-native by design — no browser or hosted dashboard.
- **Model-driven control, visibly mediated** — models call `relay_control_request_grant` to open a visible, human-approved grant request instead of silently hitting default-deny; it shows as `pending` in Command Central and is resolved with `relay session approve` / `deny` (or the palette). A model can never approve its own request (`self_approval_blocked`) or raise its own authority. Model operations (sends, inbox read/ack, grant requests) stamp `actor_kind` so the event stream shows who acted.
- **Command Central diagnostics** — `relay verify` and `relay doctor` add a Command Central read-model check: the bounded `ControlSnapshot` builds within its declared pane limits and the pending grant-request queue depth is reported, so a stalled console or a backlog of unresolved model requests surfaces without opening the TUI.

### Beyond v0.2 (planned)
- v0.3.0: per-session cost / usage rollups in Command Central; full-TTY live control via opt-in PTY
- v0.4.0: skill packs (slim), `relay run --pipe`, `relay queue cron`, `relay watch <dir>`, brew formula
- v1.0.0: stable surface, public if not already

## [0.1.2] — 2026-05-11

Codex wave-4 audit fixes — 3 privacy P1s and 5 quality P2s. No new features.

### Fixed — Codex wave-4 audit (8 findings, 3 P1 + 5 P2)

**Privacy boundary (P1):**
- **Pause sentinel gate on installed hooks** (`cmd-memory-ops.ts`) — SessionStart and SessionEnd hook commands now short-circuit via `relay pause --check` when the project or global pause sentinel is present. Previously paused sessions still recalled+injected memory and still auto-extracted, breaking the documented privacy off-switch.
- **`.relayignore` honored before extraction** (`cmd-memory-auto-extract.ts`) — Auto-extract pipeline now skips with status `skipped:project-disabled` when `<workdir>/.relayignore` is present. Previously a project opted-out via `relay project disable` still had transcript content reach the extractor and persisted as memory.
- **Workdir allowlist enforced in export** (`cmd-export.ts`) — `relay export --workdir <path>` now throws `MEMORY_WORKDIR_FORBIDDEN` when `RELAY_MEMORY_ALLOWED_WORKDIRS` is set and the requested workdir is outside the allowlist. Previously export bypassed the boundary that other memory paths enforce.

**Quality (P2):**
- **`trust_level` column kept in sync** (`memory-store.ts`) — `markRecallSuccess()` and `upsert()` now recompute and persist `trust_level` via `computeTrustLevel(memory_source, success_recall_count, pinned)`. Previously the column was only stamped at INSERT, so the `--min-trust=provisional|trusted` SQL filter silently excluded memories that had been promoted via successful recalls or pin upserts.
- **Doctor detects new `context emit` hook** (`cmd-doctor.ts`) — `checkCcGlobalHook` and `checkHookRoundtrip` now recognize both the new `relay context emit --target cc` hook and the legacy `relay memory recall | jq` pattern. Previously `relay doctor` reported `cc-global-hook` missing on healthy post-wave-4 installs.
- **Verify smoke writes pass workdir** (`cmd-verify.ts`) — `runRememberCheck`, `runRecallCheck`, and `runDbRoundtripCheck` now thread `io.cwd` as the workdir argument to `MemoryStore.remember()`. Previously a healthy install under `RELAY_MEMORY_ALLOWED_WORKDIRS` reported critical `remember`/`db-roundtrip` failures.
- **Hook uninstall idempotent on missing file** (`cmd-memory-ops.ts`) — `relay memory hook --uninstall` now returns a no-op success when `~/.claude/settings.json` does not exist. Previously it threw ENOENT on fresh `$HOME` or fresh project setup.
- **Doctor splits allowlist on `:` not `,`** (`cmd-doctor.ts`) — `checkConsentFiles` now uses colon separators to match the rest of the system (`memory-store.ts:55`). Previously the value `/proj/a:/proj/b` was treated as a single path and both projects falsely reported "consent missing".

### Other fixes (v0.1.2)
- Hardened the one-command installer and setup flow: non-interactive setup is now the default, `relay setup --clean` removes Relay-managed hooks idempotently, SessionEnd hook logging creates `~/.relay` before redirecting, and installer verification now runs `relay verify --json`.

### Tests
- 972/972 passing (+26 new tests covering all 8 codex findings).

## [0.2.0] — 2026-05-09

Cross-LLM memory injection, opt-in auto-extract pipeline, per-project privacy controls, and a complete off-switch / inspection / wipe surface. Distribution-ready: global hook install by default, `~/.local/bin` LM Studio wrapper, `relay info` + extended `relay doctor` for diagnostics.

### Added

#### Cross-LLM memory injection
- `relay context emit --target <cc|codex|lmstudio-http|lmstudio-cli>` — single command emits per-target wrapper format around recalled-memory markdown. Replaces the jq pipeline previously used in the CC SessionStart hook. Flags: `--workdir` (default PWD), `--token-budget` (default 800), `--types` (default `lesson,fact,decision,context`).
- LM Studio + OpenRouter (HTTP chat-completions + responses) + Anthropic (Messages API `system` field) workers now inject `WorkerTask.contextPrefix` as a stable system role. Enables prompt caching at the head of the message array.
- Codex worker writes `contextPrefix` to a tempfile and passes `-c model_instructions_file=<toml-quoted-path>` (the supported Codex injection path; `instructions` field is reserved). Tempfile cleanup tracked in `CodexInvocation.tempFiles` and unlinked in the runner's `.finally`.
- `scripts/relay-llm.sh` wrapper for LM Studio invocation with auto-injected memory context. Installer at `scripts/install-relay-llm.sh` deploys to `~/.local/bin/relay-llm`.

#### Opt-in auto-extract pipeline (off by default)
- `relay memory auto-extract --enable [--allow-remote]` — writes per-workdir consent file at `<workdir>/.relay/auto-extract.json`. Without this file, auto-extraction is disabled. Consent file declares remote-provider permission, byte caps, minimum confidence, and optional extra redaction patterns layered on the built-in PII set. Every extra regex is compile-tested before reaching the redaction pipeline.
- `relay memory auto-extract --from-stdin` — SessionEnd hook entry point. Parses CC hook JSON payload, checks consent, loads a trailing transcript window, redacts, calls the extractor, validates, and (optionally) Berry-checks before writing. Hooks must never block CC, so every error path returns exit 0 with a typed `skipped:*` status (`no-consent` / `bad-payload` / `no-transcript` / `empty-window` / `llm-not-wired` / etc.).
- LM Studio extraction runner (`src/memory/auto-extract-runner.ts`) — HTTP call to local LM Studio with `RELAY_AUTO_EXTRACT_MODEL` (default `qwen/qwen3-coder-next`). Returns `{status, rawOutput, durationMs}`.
- Zod schema + `cleanupAndValidate(raw, minConfidence)` (`src/memory/auto-extract-schema.ts`) — strips ` ```json ` fences (qwen wrapping), parses, validates `{content, memory_type, confidence}`, caps lessons at 3, rejects `[REDACTED:` leak, filters by minConfidence.
- Berry hallucination check helper (`src/memory/auto-extract-berry.ts`) — optional gate before lessons are written. Returns `'pass' | 'flagged' | 'unavailable'`. On unreachable endpoint or timeout returns `'unavailable'`; callers decide policy via `RELAY_AUTO_EXTRACT_REQUIRE_BERRY`.
- Extended PII redaction patterns in `src/security/redaction-pii.ts` — JWT, Stripe keys, database URLs, RFC1918 + internal LAN IPs, plus the existing API-key patterns. Applied as the pre-LLM redaction stage.

#### Off-switch + inspection + wipe
- `relay pause [--minutes N]` / `relay resume` — global off-switch. Sets a stop-flag that all hook-driven paths (recall + auto-extract) honor. `--minutes` schedules an automatic resume.
- `relay info` — overall status summary: binary version, DB stats, hook install state, last activity, providers reachable. Complements `relay doctor` (which is health checks).
- `relay memory tail [--filter <event>] [--since <duration>]` — readable activity log inspector for `~/.relay/auto-extract.log` and friends. `--filter` restricts to a single event type; `--since 24h` (or `1d`, `30m`) windows recent activity.
- `relay memory why <id>` — score breakdown explainer for a recalled memory. Shows recency, frequency, trust, query-match contributions and the final composite score.
- `relay memory forget <id>` — alias for soft-delete via supersede. Convenience for the common case.
- `relay memory wipe --workdir <path> [--hard] [--tag <name>]` — GDPR-style per-project deletion. Soft-delete by default (marks rows `superseded_by='wipe-workdir'`), `--hard` for true erasure. Optional `--tag` narrows to a label. Requires explicit `--confirm "WIPE <path>"` (or `"WIPE HARD <path>"`) phrase so the call cannot fire by accident.
- `relay export --safe [--workdir <path>]` — sharable export that filters out auto-extract entries, private (workdir-scoped) memories, and unverified-trust entries.

#### Hook installation upgrades
- `relay memory hook --install --global` — writes the SessionStart hook to `~/.claude/settings.json` (instead of project-local `.claude/settings.json`) so a single install fires in every CC project.
- `relay memory hook --install --session-end [--global]` — extends the installer to wire the SessionEnd hook for auto-extract. Combined with `--global` for user-wide setup.
- `relay init` defaults to `--global-hook`. Wizard now offers SessionEnd hook install + LM Studio model picker.

#### Per-project privacy controls
- `relay project disable | enable | audit` — opt a single workdir out of Relay's extract/recall/hook/share defaults via a `.relayignore` file (mirrors `.gitignore` in spirit).
  - `disable`: writes `.relayignore` with `extract/recall/hook=off`, `shareable=false`, then offers to add `.relayignore` to `.gitignore` so the privacy file itself does not leak via git.
  - `enable`: removes the file (interactive confirm; `--yes` skips).
  - `audit`: read-only inspection — counts deployed hooks via committed `.claude/settings.json` and counts cwd-scoped memories that `to-rules` promotion would leak into a CLAUDE.md.
  - All actions support `--json`. Audit warns and continues on parse errors so it can never block the user.

#### Recall + diagnostic surface
- `--min-trust <unverified|provisional|trusted>` flag on `relay memory recall` — trust-tier filter so SessionStart hooks can exclude auto-extracted entries by default. Threads through CLI → contract → `RecallQuery` → `buildWhereClause` SQL filter.
- `relay doctor` extended with hook-roundtrip + env-consistency + last-recall + auto-extract checks. Surfaces auto-extract status from `~/.relay/auto-extract.log`.

#### Logging + scripting infrastructure
- Centralized ndjson logger (`src/runtime/relay-log.ts`) — single writer with rotation and 30-day retention. Used by recall, auto-extract, and hook-roundtrip paths.
- `scripts/relay-llm.sh` — LM Studio CLI wrapper with auto-injected memory context.
- `scripts/install-relay-llm.sh` — installs `relay-llm` to `~/.local/bin` with smoke test.

#### Polish (also in earlier `[Unreleased]`)
- `relay completion <bash|zsh|fish>` — emit a shell completion script for the named shell. Pipe into the shell's completion location, or `eval "$(relay completion zsh)"`.
- ANSI color support across `doctor` and `history`. Honors `NO_COLOR`, `CI`, `TERM=dumb`, and stdout-not-a-TTY auto-detection. Override with `--color=always|never` flag or `RELAY_COLOR` env.

### Fixed
- `RELAY_RECALLED_LESSONS=1` was a no-op for `relay run` and `relay parallel`. Now properly wired via `buildDelegatedTask()` in both commands. (T1)
- SessionStart hook output format corrected from raw recall JSON to the documented `hookSpecificOutput.additionalContext` shape. CC was silently discarding the prior payload.
- Auto-pin tag fence: `markRecallSuccess()` no longer auto-pins entries tagged `auto-extract` regardless of recall count. The fence is at the *pin* layer, not trust-level computation — `computeTrustLevel()` still returns `trusted` after the threshold, but the missing pin keeps the entry GC-eligible. Memory poisoning protection. (T14)
- Hook `--workdir` flag now enforced under `RELAY_MEMORY_ALLOWED_WORKDIRS`. Out-of-allowlist requests are rejected.
- `HOOK_SCRIPT` constant in `src/cli/cmd-memory-ops.ts` updated to invoke `relay context emit --target cc` instead of the brittle jq pipeline.
- `relay doctor` no longer prints "All checks passed." when checks failed. Now conditional: green "All checks passed." when truly clean, red "N checks failed, M missing, K ok" on failure, gray "K ok, M missing (informational)" when only optional providers absent.
- `relay doctor --json` emits compact one-line JSON (was pretty-printed `null, 2`).
- `relay init` no longer hardcodes `-Users-ghanavati-ai-stack-Projects-relay-mcp` as the CC memory probe path. Derives `~/.claude/projects/<hash>/memory` dynamically from `io.cwd`. Now works for any user, any project.
- `relay memory to-rules` no longer appends duplicate entries when invoked twice with the same memory_id. Returns "already present" on duplicate.
- `relay history --json` emits NDJSON (one row per line) instead of a single wrapped `{runs: [...]}` object — pipe-friendly for `jq -c`.
- `cmd-history.ts:48` removed double `.padEnd(28).slice(0,28).padEnd(28)` no-op chain. Removed `as any[]` cast — defines `RunRow` interface.
- `cmd-history.ts` `formatDuration` no longer declares unused `ms` variable; uses `<1000ms` short-form.

### Changed
- `relay init` defaults to `--global-hook` (writes to `~/.claude/settings.json` instead of cwd).
- `relay memory recall` defaults `--workdir` to `process.cwd()` when `RELAY_MEMORY_ALLOWED_WORKDIRS` is set. Avoids the "broken hook" footgun where a missing flag silently widened the recall scope.
- `HOOK_SCRIPT` constant updated to use `relay context emit --target cc` instead of the jq pipeline.
- Worktree leftovers cleaned: `.gitignore` adds `.claude/tsc-cache/`. Merged worktrees + branches removed via `git worktree remove`.

### Security
- Auto-extracted entries default to `unverified` trust tier with a 30-day TTL. Never auto-pin (see auto-pin tag fence under Fixed). Trust must be earned by manual graduation.
- Per-workdir consent file required for auto-extraction (default OFF). No consent file → no extraction, regardless of env vars.
- Remote LLM auto-extraction blocked unless **both** `RELAY_AUTO_EXTRACT_ALLOW_REMOTE=1` AND consent file `allow_remote: true`. Default LM Studio HTTP path stays local-only.
- `~/.relay/secrets` enforced at `chmod 600` on touch. Loaders refuse to read world-readable secret files.

### Migration notes from 0.1.0
- Re-run `relay init --auto` to install the global SessionStart hook (replaces project-local installs).
- Existing memory entries are unaffected — schema is additive.
- Auto-extract is **OFF** until you run `relay memory auto-extract --enable` per-workdir. Without an opt-in consent file, the SessionEnd hook is a no-op.
- If you previously customized the project-local hook script, the global install does not migrate it — re-add any custom flags via `relay memory hook --install --global` and re-edit if needed.

## [0.1.1] - 2026-05-10

Wave 4a patch release. Hardens auto-extract + memory + context-emit surfaces, adds three new commands, expands docs, and lights up CI.

### Added
- `relay verify` — end-to-end smoke test command. Exercises remember → recall → context-emit → memory-rollback in one call so users (and CI) can confirm a fresh install is healthy.
- `relay memory rollback <event_id>` — undo an auto-extract or migration event. Restores prior trust tier or deletes the inserted memory based on the recorded event payload.
- `relay memory consolidate` — merge near-duplicate memory entries detected by FTS5 similarity, preserving the highest trust tier and union of tags.
- `relay init` now auto-wires detected LLM CLIs (codex, lms, anthropic, openrouter probes) into `~/.claude/relay/config.json` instead of leaving the providers section empty.
- E2E tests covering the auto-extract pipeline and the `context-emit` command surface.
- GitHub Actions test workflow (`.github/workflows/test.yml`) — runs build + `npm test` on push and PR.

### Fixed
- `relay context-emit` now defaults `--min-trust` to `provisional` (was implicitly `unverified`), matching the documented "safe-by-default" recall posture.
- `MemoryStore.wipeWorkdir` escapes `%` and `_` in LIKE patterns so workdirs containing those characters are matched literally instead of as wildcards.
- `relay memory hook` install/uninstall now matches the stable `<!-- relay:memory-hook -->` marker, so re-running install does not duplicate the block and uninstall correctly removes it even if the surrounding content changed.
- `relay doctor` adds a `checkAutoExtractStatus` check that reports whether the auto-extract hook is wired and last ran successfully.

### Docs
- README rewritten around the v0.1.1 surface and the new `relay verify` quickstart.
- New cookbook (docs/cookbook.md) with end-to-end recipes for auto-extract, parallel dispatch, and memory rollback.
- New troubleshooting guide (docs/troubleshooting.md) covering the most common doctor-failure paths.
- AGENTS.md gains a "Wave 4 lessons" section capturing the patterns that hardened auto-extract and memory.

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

[Unreleased]: https://github.com/ghanavati/relay/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/ghanavati/relay/compare/v0.1.1...v0.1.2
[0.2.0]: https://github.com/ghanavati/relay/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ghanavati/relay/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ghanavati/relay/releases/tag/v0.1.0
