# Phase 5 Plan Verification — Conflict Detection

**Date:** 2026-05-19
**Plan:** `.planning/phases/05-conflict-detection/PLAN.md`
**Verifier:** `gsd-plan-checker` (goal-backward)

## Verdict

**ISSUES FOUND (2 warnings, 0 blockers)** — Plan will achieve all 5 ROADMAP success criteria; minor inaccuracies should be corrected before execution but do not endanger the goal.

## ROADMAP Success Criteria → Task Coverage

| SC# | Criterion | Tasks | Status |
|-----|-----------|-------|--------|
| 1 | Reciprocal mutual `conflicts_with_json`, same transaction | T1 (column), T3 (transaction wrap + reciprocal UPDATE) | COVERED |
| 2 | `ANNOTATE_BOTH` default, pinned never dropped | T4 (default policy + pinned bypass), T6 (render `⚠ CONFLICTS WITH #N`) | COVERED |
| 3 | Cosine ≥ 0.7 suppresses paraphrase false positive | T5 (post-EMBED cosine gate, both-peers-have-blob guard) | COVERED |
| 4 | Workdir-scoped only, never cross-workdir | T3 strict `workdir = ?` query + T7 grep guard against `workdir IS NULL` | COVERED |
| 5 | K cap = 32 per recall pairwise pass | T4 (`RECALL_K_CAP=32` slice between filter and pack loop) | COVERED |

## REQ-ID Coverage (CONFLICT-01..05)

| REQ-ID | Tasks | Evidence |
|--------|-------|----------|
| CONFLICT-01 | T1 | PRAGMA-guarded ALTER at `db-migrations.ts:101`, mirrors `embedding_blob` pattern at `:94-100` |
| CONFLICT-02 | T2 (`isConflictCandidate`), T3 (write-time invocation) | Thresholds `TAG_JAC_MIN=0.5`, `CONTENT_JAC_MAX=0.3`, `MIN_SHARED_TAGS=2` in `conflict-thresholds.ts` |
| CONFLICT-03 | T4 | `resolveConflicts` between filter (`:208`) and pack loop (`:215`); `ANNOTATE_BOTH` default; precedence trust → score → recency; cap K=32 |
| CONFLICT-04 | T5 | `COSINE_GATE_MAX=0.7`; degrades to Jaccard-only when either `embedding_blob` null |
| CONFLICT-05 | T3 SQL, T7 grep guard | Workdir-strict-equal SQL; explicit deviation from MEMORY-MAP W1's `workdir IS NULL OR =` pattern, justified by CC.3 |

All 5 REQ-IDs present in plan frontmatter `requirements` field. All 5 have implementing task(s).

## Two-Pass Recall + memory-engine.ts Purity

Plan honored. T4 refactors `budgetedRecall` into pure orchestrator:
```
scoreCandidates (pure) → resolveConflicts (pure, from ./conflict-detection) → packToBudget (pure)
```
- T2 enforces `conflict-detection.ts` imports only `./types`, `./conflict-thresholds` (grep check).
- T4 REFACTOR confirms `memory-engine.ts` has no `better-sqlite3`, `node:http`, `node-fetch`, `../runtime/*` imports.
- Cosine helpers (T5) live in `memory-store.ts` (impure layer), NOT `memory-engine.ts` — correct.

**Verified against codebase:** `memory-engine.ts:195` shows `budgetedRecall` signature `readonly Memory[], query: RecallQuery, now: number): RecallResult` — refactor preserves it.

## Phase 4 Dependency Handling

Plan correctly declares `depends_on: [04-embeddings-wire-up]`. **Degradation plan present** (T5 precondition probe):
- Probes schema for `embedding_blob` AND non-null row → if absent, skips cosine gate with `// TODO PHASE-5: re-enable when Phase 4 lands` sentinel, ships Jaccard-only, documents in CHANGELOG.
- T3 `detectConflicts` written so cosine gate is inert when both blobs null — Phase-4-not-ready degrades silently.
- Mixed-presence fallback (one blob null) explicitly tested in T5: falls back to Jaccard-only, no crash, no error log.

**Risk register row** for "Phase 4 not landed" rates this LOW impact with degradation plan. Plan is execution-independent of Phase 4 wall-clock.

## Detection at WRITE Time Only

Verified. T3 implements detection inside `db.transaction(...)` in `remember()` (`:273-348`) and `upsertTx()` (`:379-444`). T4 recall-time pass is annotation-only — it READS `conflicts_with` from rows but does NOT compute new conflict candidates. WRITE_CANDIDATE_CAP=50 prefilter bounds write-time cost (PITFALLS 3.1).

## Reciprocal Update Same Transaction

Verified. T3 GREEN step 1 explicitly:
1. Wraps INSERT + reciprocal UPDATE in single `db.transaction(...)`.
2. Atomicity test monkey-patches the UPDATE to throw — asserts INSERT rolled back.
3. Pattern: `UPDATE memories SET conflicts_with_json = json_insert(coalesce(conflicts_with_json,'[]'), '$[#]', ?) WHERE memory_id = ?` (per DELTA-MEM-CONFLICT.md §4 W4).

## Pinned Protection (Top of Precedence)

Verified. T2 `resolveConflicts` test explicitly asserts pinned survives even under `drop-lower-trust` policy. T4 recall test re-confirms end-to-end. Risk register row "Pinned memory dropped" rates LOW likelihood with these guards.

## ANNOTATE_BOTH Default + Configurable

Verified. T4 sets `RecallQuery.conflictPolicy` default `'annotate'` when undefined; T2 implements three policies (`'annotate' | 'drop-lower-trust' | 'drop-all-conflicts'`). RecallQuery field is optional → backward-compat additive.

## K=32 Cap (O(K²) Bounded)

Verified. T4 caps input to `resolveConflicts` at `RECALL_K_CAP=32`. Worst case = 1024 comparisons, sub-millisecond. T2 test asserts <100ms upper bound; T4 K-cap test confirms rows beyond sort position 32 pass through un-annotated.

## Threshold Verification

Plan thresholds match REQ + ROADMAP exactly:
- `TAG_JAC_MIN=0.5` (REQ CONFLICT-02: "tag_jaccard > 0.5")
- `CONTENT_JAC_MAX=0.3` (REQ CONFLICT-02: "content_jaccard < 0.3")
- `MIN_SHARED_TAGS=2` (REQ CONFLICT-02: "≥2 shared tags")
- `COSINE_GATE_MAX=0.7` (REQ CONFLICT-04: "cosine < 0.7"; ROADMAP SC#3 paraphrase ≥ 0.7 suppresses)
- `WRITE_CANDIDATE_CAP=50` (write-time prefilter, PITFALLS 3.1)
- `RECALL_K_CAP=32` (ROADMAP SC#5)

## Render Path

T6 modifies `context/layers.ts:252-259`. Verified live code at that range:
- Line 244-250: failure-first sort (preserved by plan).
- Line 255-256: existing `[UNVERIFIED]` + `⚠ FAILED:` prefix chain — plan extends with `⚠ CONFLICTS WITH #N` via `[unverifiedMarker, failureMarker, conflictPrefix].filter(Boolean).join(' ')`.
- UUID→#N translation map built once per render (correct — index = position in rendered list).
- Dangling-reference safety: if peer filtered out by `MIN_RELEVANCE_SCORE`, annotation dropped gracefully.

## Caller Signature Compatibility

**WARNING #1 — caller count off-by-one:** Plan claims "All 5 callers of budgetedRecall remain compatible". Codebase shows **4 callers**: `src/tools/memory_search.ts:38`, `src/tools/recall.ts:28`, `src/context/layers.ts:231`, `src/cli/cmd-tui.ts:89`. The fifth caller (`src/cli/cmd-memory-recall.ts`) does not exist yet — it's a Phase 4 deliverable per EMBED-04. Plan additive design (optional `conflictPolicy`, optional `annotations`) handles both current 4 callers AND future Phase 4 caller. Fix: change "5 callers" → "4 current callers (+ Phase 4's `cmd-memory-recall.ts` will inherit additive signature)".

## Risk Register Completeness

All requested risks present in plan §"Risk register" (lines 300-314):
- False positives ✓ (HIGH→LOW via T5)
- O(K²) cost ✓ (capped K=32)
- Workdir leak ✓ (T7 grep guard + strict-equal SQL)
- Pinned interaction ✓ (T2 + T4 explicit tests)
- Migration backfill ✓ (default `'[]'` makes legacy rows read-safe)
- Transaction rollback ✓ (T3 atomicity test)

Additional risks plan correctly flagged: cross-model cosine (PITFALLS 2.3), engine purity erosion (CC.4), Phase 4 not landed, `upsert()` forgotten path, caller signature break.

## Scope Sanity

- 7 tasks (above 2-3 target, but justified by interface-first TDD discipline — T1 schema, T2 pure helpers, T3 write, T4 recall, T5 cosine augment, T6 render, T7 regression suite).
- 10 files modified, 7 new test files. Borderline but plan explicitly sequences for blast-radius isolation.
- **WARNING #2 — task count borderline:** 7 tasks risks context-budget pressure during execution. Mitigated by clear interface contracts between tasks (T2 helpers stable before T3 consumes them; T5 augments T3 inertly). Acceptable given hard-constraint density (purity, atomicity, workdir isolation, Phase-4 conditional).

## Gaps

None blocking. Two minor accuracy corrections recommended:
1. Caller count: 5 → 4 (Phase 4 adds the 5th).
2. Plan §"Files explicitly NOT touched" omits `src/memory/auto-extract-runner.ts` as Phase 6 territory — actually present (line 330). ✓ No gap.

## Recommendation

**APPROVE for execution** with the 2 warnings noted. Plan demonstrates rigorous goal-backward derivation: each ROADMAP SC traces to specific test + GREEN step + REFACTOR. Hard constraints (engine purity, transaction atomicity, workdir strict-equal) are enforced by grep guards, not just hope. Degradation path for Phase-4-not-ready is concrete.
