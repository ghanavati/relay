# Relay

Local-first CLI giving any LLM persistent memory across sessions + multi-LLM tool routing with privacy gates and hallucination verification.

## What This Is

Solo CLI (TypeScript, Node 20+, single SQLite store) for delegating bounded coding tasks to AI workers (Codex CLI, OpenRouter HTTP, LM Studio HTTP, Anthropic Messages API) and carrying persistent memory across Claude Code sessions. Local-first, model-agnostic. No external services required.

Currently v0.1.2 — 972 tests passing. Distribution-ready surface: `relay setup --everything`, `relay verify`, `relay doctor`, `relay memory *`, `relay run`, `relay parallel`, `relay context emit`, `relay budget show` (stub), `relay export`, etc.

## Core Value

Carrying memory + agency across LLM tools so the user doesn't lose context every session. Privacy gates (consent files, pause sentinel, `.relayignore`, workdir allowlist) + hallucination verification via Berry MCP. Local-first means no cloud dependency.

## Validated Requirements (shipped through v0.1.2)

### Memory subsystem
- [x] **MEM-01**: User can `remember` / `recall` / `search` memories with token budget, tag scoping, trust tiers
- [x] **MEM-02**: User can inspect memories via `get` / `why` / `diff` / `chain` / `recent`
- [x] **MEM-03**: User can consolidate near-duplicates via `consolidate`
- [x] **MEM-04**: User can rollback auto-extract / migration events via `memory rollback`
- [x] **MEM-05**: User can wipe / export memories with workdir scoping

### Cross-LLM context injection
- [x] **CTX-01**: `relay context emit --target <cc|codex|lmstudio-http|lmstudio-cli>` injects recalled memory in per-target wrapper format
- [x] **CTX-02**: LM Studio + OpenRouter + Anthropic workers inject `WorkerTask.contextPrefix` as stable system role
- [x] **CTX-03**: Codex worker injects via tempfile + `model_instructions_file=`

### Privacy + safety
- [x] **PRIV-01**: `relay pause` / `resume` off-switch for hook-driven paths
- [x] **PRIV-02**: Per-workdir consent file (`<workdir>/.relay/auto-extract.json`) required for extraction
- [x] **PRIV-03**: `RELAY_MEMORY_ALLOWED_WORKDIRS` enforced across recall + extract + export
- [x] **PRIV-04**: `.relayignore` honored before extraction (P1 codex fix)
- [x] **PRIV-05**: PII redaction (JWT, Stripe, DB URLs, RFC1918) applied pre-LLM
- [x] **PRIV-06**: Berry hallucination check gate for auto-extracted lessons

### Workers + dispatch
- [x] **WRK-01**: Codex worker (agentic subprocess, modifies files)
- [x] **WRK-02**: LM Studio worker (single-shot HTTP, `agentic: false`)
- [x] **WRK-03**: OpenRouter worker (single-shot HTTP)
- [x] **WRK-04**: Anthropic worker (single-shot Messages API)
- [x] **WRK-05**: `relay run` + `relay parallel` dispatch

### Diagnostics + setup
- [x] **DIAG-01**: `relay setup --everything` non-interactive
- [x] **DIAG-02**: `relay verify` end-to-end smoke
- [x] **DIAG-03**: `relay doctor` 10-check health (provider, DB, hook, auto-extract)
- [x] **DIAG-04**: `relay info` enriched (DB size, memory counts, 24h activity)
- [x] **DIAG-05**: `relay completion <bash|zsh|fish>` shell completion

### Auto-extract pipeline
- [x] **EXT-01**: SessionEnd hook → auto-extract from transcript window (consent-gated)
- [x] **EXT-02**: LM Studio extraction runner (qwen3-coder-next default)
- [x] **EXT-03**: Zod-validated `{content, memory_type, confidence}` schema with cleanup

## Current Milestone: v0.2 — Agentic capability + memory upgrades

**Goal:** Local LLMs gain tool-using agentic loop; memory gains semantic recall, conflict detection, delta extraction; Figma integration shipped; schema cleaned; budget command surfaces costs.

**Target features:**
- Schema cleanup (drop 11 orphan tables, add `schema_version` table)
- Agentic local LLM runner (new `src/workers/lmstudio-agentic.ts` with tool-calling loop)
- Figma integration via agentic local runner (depends on agentic runner)
- Conflict detection in memory recall (δ-mem inspired)
- Semantic embeddings via nomic-embed-text-v1.5
- Delta extraction in auto-extract
- Budget command (deferred from v0.1)

**Constraints:** NO codex (CC subagents only). TDD strict. Local models (qwen3-coder-next + nomic-embed) as RUNTIME targets, not code writers. Workdir-scoped privacy preserved.

## Out of Scope

- Cloud-hosted memory store — local-first by design
- Multi-user / team features — solo CLI
- Web UI — TUI roadmap planned for v0.3 (Ink-based)
- API server — CLI + MCP server only

## Key Decisions

- **Local-first SQLite** — better-sqlite3, single file, no external DB
- **Worker contract is text-in/text-out** — except Codex (agentic subprocess)
- **Hooks must never block CC** — every error path returns exit 0 with typed `skipped:*` status
- **Auto-extract is OFF by default** — opt-in per workdir via consent file
- **Trust tiers earned, not granted** — auto-extracted entries default `unverified`, 30-day TTL, never auto-pin
- **AGPL-3.0-or-later license**

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

Last updated: 2026-05-18 (bootstrap for GSD adoption — pre-v0.2 milestone)
