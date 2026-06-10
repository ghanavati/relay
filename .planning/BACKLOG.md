# Backlog — parked with triggers

Items live here ONLY with a why and a build-trigger. No trigger fired = no build. Discipline per `LESSONS-FROM-RELAY-MCP.md` (the predecessor died of building parked ideas).

## B-01: Swarm reliability layer (v0.5 candidate)

**What:** Make `relay parallel` trustworthy at 100+ tasks. Today (verified 2026-06-09, src/cli/cmd-parallel.ts): bounded-concurrency lane pool with no structural cap — it FIRES huge swarms fine, but has no resilience: no retry, no backoff, no queue persistence (crash = lost swarm), no resume, no per-provider rate-limit handling.

**Build list when triggered:**
- Persistent queue: spec ingested into SQLite (runs already recorded — add queue state), so a crashed/killed swarm resumes with `relay parallel --resume <batch_id>` instead of restarting.
- Retry with exponential backoff per task; respect `Retry-After` on 429; cap attempts; dead-letter list in the batch summary.
- Per-provider concurrency limits (lmstudio lanes ≠ openrouter lanes — one Mac vs an API), not one global `--max-concurrency`.
- Batch-level receipt rollup (sum of raw usage receipts — still no price math).

**Why Relay:** dispatch-core, not scope sprawl. Nothing in the surveyed field ships this (ai-devkit manages a handful of interactive sessions; no queue/retry there either). Closest thing to a real differentiator next to memory.

**Trigger:** first real swarm run >20 tasks, or a failed/crashed batch that hurt.

## B-02: claude-code headless worker runner (OAuth lane #2)

**What:** `claude -p` subprocess runner so swarms can dispatch to Claude Code on subscription quota, same as codex today. Rides the 09-01 provider registry (builtin entry + subprocess runner, like CodexRunner). Phase 8 made Claude Code a *controllable session*; this makes it a *dispatchable worker* — different thing.

**Trigger:** a swarm task that actually needs Claude quality where codex/local won't do. Cheap to build once wanted; don't pre-build.

## B-03: tmux live_stdin delivery adapter (port of ai-devkit's TtyWriter pattern)

**What:** Phase 8's capability ladder (live_stdin > resume_send > context_inject > mailbox) has no live_stdin implementation for ambient sessions. ai-devkit proved the mechanic (assessed 2026-06-09, packages/agent-manager/src/terminal/): `tmux send-keys -t <session> -l <text>` (literal mode, no shell interpretation), 150ms delay, then separate `send-keys Enter` to beat bracketed-paste mode. Port = one adapter implementing the existing delivery capability for tmux-hosted sessions.

**Scope fence:** tmux only. Do NOT port the AppleScript iTerm2/Terminal.app paths (synchronous blocking calls, no timeouts, macOS accessibility permissions — fragile by their own code's evidence).

**Trigger:** real need to steer a session Relay doesn't own and hooks can't reach. Until then, mailbox + context_inject cover it.

## B-04: Multi-CLI ambient session discovery (gemini / copilot / opencode)

**What:** ai-devkit ships parse-at-rest discovery for 5 agent CLIs (session-file locations + status heuristics per CLI; `ps aux` + registry with PID-reuse staleness checks). Relay has claude-code (hooks) + codex (conservative). Adding gemini/copilot/opencode discovery would widen `relay session list`.

**Fragility (their own failure modes, avoid importing them):** tight coupling to undocumented session-file formats, no format versioning, lossy cwd path encoding (collisions), 3-minute birthtime matching heuristic, greedy 1:1 matching that degrades with multiple agents per cwd. If built: adopt their PID-staleness check + atomic registry write; reject the birthtime heuristic (require explicit registration or resume-UUID match).

**Trigger:** user actually runs one of those CLIs alongside Relay regularly.

## B-05: Memory ranking scope-boost (micro)

**What:** ai-devkit's ranker adds a flat scope bonus (exact project scope +0.5, global +0.2) on top of BM25. Relay scopes by filter (workdir WHERE clause), not by boost. A small exact-workdir boost in scoring could improve mixed global/project recall ordering.

**Trigger:** observed recall ordering complaint where global memories outrank more-relevant project ones. One-line-ish change in memory-engine scoring; measure before/after.

## Explicitly NOT backlog (assessed and rejected, 2026-06-09)

- **Channel bridging (Telegram/Slack control of agents)** — ai-devkit ships it; their auth is first-Telegram-user-wins = whole-terminal access on one leaked token. New product surface + remote-control risk class. Relay stays local-first; v2 remote MCP is the only sanctioned remote door.
- **Provider-config codegen** (generating .claude/.cursor/.codex config trees) — hosts own their config; GSD owns workflow scaffolding. Not Relay.
- **Phase-doc workflow templates / skill registry curation** — GSD territory, duplicated effort.
- **Swarm orchestration brain** (decompose/dedup/merge) — stays in the orchestrator (Claude Code/Conductor). Relay = dispatch primitive + shared memory + receipts (see RELAY-V04-SCOPE.md).

## Carried from Phase 8

- cmd-session.ts (970 lines) + broker.ts (985) exceed the 800-line cap — split refactor.
- control-e2e.test.ts grant fixtures use absolute expiry timestamps (time bombs — expired 2026-06-09, 2 permanent failures). Fix: relative-to-now fixtures. Forensics in deferred-items.md.

## Phase 9 follow-up (not backlog — committed scope)

- `relay parallel` through the 09-01 provider registry: cmd-parallel.ts still carries its own closed 5-provider union + duplicated getRunner (lines 21, 38-73, 123). Mechanical swap to resolveProvider + the runner factory once 09-01 lands. Do before phase close.

## B-06: Hash-chained memory/audit ledger (Berry pattern)

**What:** Tamper-EVIDENT (not tamper-proof) SQLite: each memory write / audit event row stores sha256(prev_row_hash + canonical(row)); `relay doctor --verify-chain` walks and flags breaks. Pattern from Berry/hallbayes's audit ledger (read 2026-06-09).

**What it buys:** detection of out-of-band edits (memory-poisoning forensics, "did this row change behind my back"), integrity for the Phase 8 audit trail. What it does NOT buy: protection — file-access attacker rewrites the whole chain unless root hashes export elsewhere. Supersession history + memory diff/rollback already cover normal change tracking.

**Trigger:** first real memory-integrity dispute, a poisoning incident, or any multi-actor deployment. Solo-local value is thin; do not pre-build.
