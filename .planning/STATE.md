---
gsd_state_version: 1.0
milestone: v0.2
milestone_name: milestone
status: planning
stopped_at: Completed 01-01-PLAN.md (Phase 1 Schema Cleanup)
last_updated: "2026-05-19T19:37:02.634Z"
last_activity: 2026-05-19 — ROADMAP.md created via gsd-roadmapper for v0.2 milestone
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 0
  completed_plans: 1
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-18)

**Core value:** Carrying memory + agency across LLM tools so the user doesn't lose context every session; local-first SQLite + Berry hallucination verification + privacy gates.
**Current focus:** Phase 1 — Schema Cleanup (v0.2 prerequisite)

## Current Position

Phase: 1 of 7 (Schema Cleanup)
Plan: 1 of 1 in current phase (Complete)
Status: Phase 1 complete — ready to start Phase 2
Last activity: 2026-05-19 — Phase 1 plan 01 executed (7 commits, 1126 tests passing)

Progress: [█░░░░░░░░░] 14%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1. Schema Cleanup | 0 | — | — |
| 2. Budget Verification | 0 | — | — |
| 3. Agentic LM Studio Runner | 0 | — | — |
| 4. Embeddings Wire-Up | 0 | — | — |
| 5. Conflict Detection | 0 | — | — |
| 6. Delta Extraction | 0 | — | — |
| 7. Figma REST Tools | 0 | — | — |

**Recent Trend:** No data yet (milestone just opened)

*Updated after each plan completion*
| Phase 01-schema-cleanup P01 | 1h35m | 5 tasks | 14 files |

## Accumulated Context

### Decisions

Recent decisions affecting v0.2 work (full log in PROJECT.md):

- **Sequencing**: F4 (embeddings wire-up) before F3 (conflict detection) per research/SUMMARY.md §3 — cosine gate sharpens conflict thresholds, avoids re-tuning after F4 lands
- **Stack discipline**: Only `ws@^8.20.1` + `@types/ws@^8.18.1` new runtime adds for entire v0.2; native fetch mandatory; no axios/openai-sdk/zod4/sqlite-vec
- **Codex-free**: NO codex used to implement v0.2 (CC subagents only per PROJECT.md constraint)
- **TDD strict**: RED → GREEN → IMPROVE, 80%+ coverage, node:test framework
- **Local models as runtime targets**: qwen3-coder-next + nomic-embed-text-v1.5 are RUNTIME targets, not code writers
- [Phase 01-schema-cleanup]: Used sync copyFileSync for production .v1-backup (getDb is sync). Async db.backup() retained for tests + future async callers via prepareDatabase.
- [Phase 01-schema-cleanup]: Fixed pre-existing npm test glob (sh/macOS bash 3.2 lacks globstar); test baseline went 1003 → 1107 from discovery alone before phase work added 19 more.

### Partial v0.2 work already shipped (verified via git log)

- `a2b3a54` — `src/memory/embedding-client.ts` (8.3K, 18 tests) — wraps LM Studio `/v1/embeddings`
- `e3f3a9a` — `embedding_blob BLOB` column added to memories table (3072 bytes/row, little-endian Float32Array)
- `1728686 / b7f5083` — `BudgetStore.getUsage()` with provider/workdir/period scoping
- `4d21e99` — `cmd-budget` v0.2 implementation with all flags
- `00ad578 / d4804c6` — Budget scope CHECK constraint expanded to admit `provider` + `workdir`

These commits inform Phase 2 (Budget Verification) and Phase 4 (Embeddings Wire-Up) — the foundations exist; remaining work is integration/wire-up plus migration chain verification.

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

Open questions from research/SUMMARY.md §6 (no source can resolve — require user decision during planning):

1. **F1 fixture provenance** — anonymized user DB or synthetic? (Phase 1)
2. **F2 tool dispatch** — `RELAY_LMSTUDIO_AGENTIC=1` env or `WorkerTask.agentic === true`? (Phase 3)
3. **F4 wire-up** — sync vs async embed-at-write; background micro-task as unawaited Promise or `setImmediate`? (Phase 4)
4. **F3 default threshold** — start at `1 - cosine > 0.5`? (Phase 5)
5. **F6 file_key origin** — workdir consent file or env var? (Phase 7)
6. **F5 queue worker invocation** — cron / next SessionStart hook / manual? (Phase 6)
7. **Schema versioning scope** — only Relay tables, or budget chains in? (Phase 1 → affects Phase 2)

Top blast-radius pitfalls to enforce at gate (research §4):

- F1: v0.1.2→v0.2 DB upgrade breaks recall (CATASTROPHIC — data-loss) → require `src/memory/__fixtures__/v0.1.2-baseline.db` fixture to pass before merge
- F6: Figma PAT leaked in debug logs / committed `.env` (CATASTROPHIC — credential rotation + git history scrub)
- F3+: Workdir scoping leak (HIGH — cross-project memory contamination)

## Session Continuity

Last session: 2026-05-19T19:37:02.633Z
Stopped at: Completed 01-01-PLAN.md (Phase 1 Schema Cleanup)
Resume file: None
