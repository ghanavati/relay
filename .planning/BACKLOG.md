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

**Port sources (verified WIRED in relay-mcp, 2026-06-10 read — pattern-port fresh code, same as the registry):**
- Dependency-wave scheduler with cycle detection + output injection: `relay-mcp/src/tools/delegate_parallel.ts:183-215, 387-406` (+ its 3 deps/waves test files).
- Git worktree isolation per worker (symlinked dep dirs, merge-back with conflict list, idempotent cleanup): `relay-mcp/src/git/worktree.ts:36-149`.
- Mutex-with-drain (per-workdir, timeout + orphan drain): `relay-mcp/src/concurrency/index.ts:16-63`.
- Run-store OCC (`version` column) + append-only run_events + immutability triggers for concurrent-writer safety: `relay-mcp/src/runtime/store/db.ts:25-53,152-162`, `run-store.ts:119-171`.

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

**Evidence log (2026-06-10):** query "what did we agree relay scope bloat" at token_budget 300 returned an adjacent-topic pinned global fact (0.674, 240 tokens — ate the whole budget) ahead of the exact-topic pinned project decision. At budget 800 the decision surfaces. Two candidate levers when triggered: exact-workdir boost; consider content-match weight vs pinned bonus at small budgets. Trigger is now half-fired — one more real complaint and this builds.

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

## B-07: SSRF + private-IP guard on provider URLs (relay-mcp port)

**What:** Outbound-URL guard for dynamic providers: block RFC1918/loopback/link-local/CGNAT targets unless explicitly allowed (`RELAY_ALLOW_INTERNAL=1` style escape for lmstudio/localhost), plus the workdir denylist with realpath resolution. Verified WIRED in `relay-mcp/src/security/middleware.ts:8-128` (29 tests).

**Why parked, not shipped:** Phase 9's threat model ACCEPTED user-set provider URLs as user trust (T-09-03) — the env var is the user's own config, same trust as editing a file. Localhost is also the NORMAL case here (LM Studio), so naive SSRF blocking would break the primary local workflow.

**Trigger:** provider URLs ever come from anywhere other than the user's own env (config files from repos, MCP-writable config, team sync), or Relay gains any surface where a model can influence the URL.

## B-08: context_mode minimal + input-token preflight cap (relay-mcp port)

**What:** Per-dispatch `context_mode: full|minimal` (minimal injects only worker constraints, saving ~10K tokens per dispatch) + `RELAY_INPUT_TOKEN_CAP` preflight rejection. Verified WIRED in `relay-mcp/src/context/layers.ts:336-354` + delegate preflight. The free cost lever that needs no price map.

**Trigger:** measured context bloat — a real dispatch where injected context dwarfs the task, or swarm runs (B-01) where 10K × N tasks = real waste. Likely lands WITH B-01.

## B-09: World-class memory/context options (the dumb-substrate set)

**What:** A ranked set of mechanism-not-policy options that make any model that mounts Relay more effective without Relay growing a brain. Full record + anti-creep status + per-item triggers in `AGENT-DIRECTION.md`. Top three (nobody else does them, all pure mechanism): (1) git-native portable memory — `relay memory export/import` to owned, diffable, git-syncable files; (2) `relay context explain` — deterministic, debuggable context (what gets injected, each score, what the budget dropped); (3) model-facing curation MCP tools (pin/forget/correct/scope) — the model steers its own memory. Then (4) be THE memory MCP (polish + open format), (5) context snapshots/replay, (6) dispatch receipts with an outcome slot.

**Governing rule (also in AGENT-DIRECTION.md):** Relay is mechanism, not policy. Grep-able enforcement — Relay's own logic makes zero LLM calls to decide things. Any "router" stays declarative rules; any "intent" is model-declared, never inferred. Reject the inference version of every item.

**Trigger:** per-item, see AGENT-DIRECTION.md. The verification-native spine item has already fired (2026-06-22 stale-cache mislead). Options 1 and 2 are the recommended first proof.

## B-10: memory remember — workdir-gate error should name the fix

**What:** With `RELAY_MEMORY_ALLOWED_WORKDIRS` set, `relay memory remember` without `--workdir` throws `MEMORY_WORKDIR_FORBIDDEN: "Cross-workdir memory access is not permitted in this context"` — correct gate, useless message. It should say *why* (no workdir supplied while an allowlist is active) and *what to do* (`pass --workdir <path>`, list the allowed roots). Optionally: default workdir to `process.cwd()` when cwd falls inside the allowlist — saves the flag in the 99% case without weakening the gate. Gate lives at `src/memory/memory-store.ts:69` (assertWorkdirAllowed); CLI flag exists at `src/cli/cmd-memory-ops.ts`.

**Why parked:** one-line-ish DX fix, no dispatch/memory/receipt behavior change; discovered 2026-07-04 when session-hook env (which sets the allowlist) made every bare `remember` fail — five saves bounced before the flag was found by reading source.

**Trigger:** already fired once (2026-07-04, this session). Ship with the next Relay maintenance pass.

## B-11: local (oMLX) auto-extract option — recipe parked

**What:** Optional offline/private memory extraction on a local model instead of Codex.
Recipe: set consent `extractor: "lmstudio"`, `LMSTUDIO_ENDPOINT=http://127.0.0.1:8000`,
`RELAY_AUTO_EXTRACT_MODEL=<non-thinking, e.g. Qwen3-Coder-Next-MLX-6bit or gemma-26b>`, and
oMLX `skip_api_key_verification=true` (loopback-only; the extract runner sends NO auth header —
`src/memory/auto-extract-runner.ts` has no Bearer). Then verify one real harvest + quality-check.

**Why parked (2026-07-04):** auto-extract is currently `extractor: codex` and WORKS (cloud,
higher quality). Not broken — shutting LM Studio down did not kill it (my earlier claim was wrong).
Local is an offline/privacy UPGRADE, not a repair, and Codex extraction quality > local.

**Trigger:** you want session-learning to run fully offline/private, OR Codex quota becomes a
constraint. Until then, Codex stays.

## B-12: session registration was silently broken; live CC control is turn-gated

**What:** Until 2026-07-04 no CC session registered as an ACTIVE control session — the global
SessionStart hook ran `relay memory recall` only; `relay context emit` (which registers) ran
just at SessionEnd (which stop-marks). Net: `relay session list` showed every session `ended`,
`relay session send` had no live target. Fixed by adding a SessionStart context-emit hook globally.

**Deeper limits to design around:** (1) CC is `live_control:false` — sessions are addressable +
mailbox-queueable but NOT real-time controllable; delivery is turn-gated at hook boundaries.
(2) An already-running session can't register without a restart (SessionStart is one-shot).
(3) Registration `relay context emit` errors (non-fatally) when workdir ∉ RELAY_MEMORY_ALLOWED_WORKDIRS
— registration still lands but the noise is ugly; consider a quiet-register path.

**Trigger:** if live cross-session coordination becomes a real workflow (it nearly did today —
fleet session ↔ inspo-library session), make registration robust: emit on SessionStart AND a
per-turn hook, add a `relay session register` explicit command for mid-life registration, and
document the turn-gated-delivery reality so users don't expect real-time puppeteering.
