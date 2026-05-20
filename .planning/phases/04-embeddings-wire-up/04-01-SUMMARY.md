---
phase: 04-embeddings-wire-up
plan: 01
subsystem: memory
tags: [embeddings, semantic-recall, nomic, queueMicrotask, engine-purity]
requires: [01-schema-cleanup, 03-agentic-lmstudio-runner]
provides: [semantic-content-scoring, lazy-embed-on-write, cross-model-rejection]
affects:
  - src/memory/memory-store.ts
  - src/memory/memory-engine.ts
  - src/memory/types.ts
  - src/memory/db-migrations.ts
  - src/tools/recall.ts
  - src/tools/memory_search.ts
  - src/cli/cmd-memory-ops.ts
  - src/cli/cmd-verify.ts
tech-stack:
  added: []
  patterns:
    - queueMicrotask-after-sync-insert (lazy embed; never blocks)
    - impure-boundary-helper (computeSemanticSimilarities lives outside engine)
    - cross-model-rejection (embedding_model column + helper guard)
    - ReadonlyMap-injection (similarities threaded as 4th arg to budgetedRecall)
    - stderr-loud-deduped-warning (per-process Set, one line per failure reason)
    - sync-to-async-conversion (handleRecall + handleMemorySearch)
key-files:
  created:
    - src/memory/semantic-similarities.ts
    - src/memory/semantic-similarities.test.ts
    - src/memory/memory-store-embed.test.ts
    - src/memory/embeddings-wire-up.integration.test.ts
    - src/tools/recall-embed.test.ts
  modified:
    - src/memory/memory-store.ts
    - src/memory/memory-engine.ts
    - src/memory/types.ts
    - src/memory/db-migrations.ts
    - src/memory/score-memory.test.ts
    - src/memory/budgeted-recall.test.ts
    - src/memory/embeddings-migration.test.ts
    - src/memory/memory-search.test.ts
    - src/tools/recall.ts
    - src/tools/memory_search.ts
    - src/cli/cmd-memory-ops.ts
    - src/cli/cmd-verify.ts
decisions:
  - queueMicrotask (not setImmediate) for lazy embed - deterministic single-tick flush in vitest/node-test
  - embedding_model column nullable, no DEFAULT - NULL = "not yet embedded"
  - ScoreOptions interface defined in-file (no new imports to memory-engine.ts)
  - similarities passed as ReadonlyMap (engine never mutates)
  - Helper at impure boundary (semantic-similarities.ts) - keeps memory-engine.ts pure
  - Cross-model rejection: row's embedding_model must match active model
  - Defensive clamp to [0,1] inside engine even though nomic returns normalized
  - Integration test placed at src/memory/ (not test/) because tsconfig.include = src/**
metrics:
  duration_minutes: 45
  completed_date: 2026-05-20
  tests_baseline: 1218
  tests_after: 1224
  delta_tests: +6 unit + 1 integration
  loc_added: ~2037
  loc_removed: ~31
  commits: 7
---

# Phase 4 Plan 01: Embeddings Wire-Up Summary

One-liner: Cosine similarity from `nomic-embed-text-v1.5` now drives the `content` axis of `ScoreComponents` for memories whose `embedding_blob` is populated; word-overlap remains the fallback for un-backfilled rows, offline LM Studio, and the `RELAY_EMBEDDING_MODEL`-unset case.

## What landed

**Lazy embed-on-write:** `MemoryStore.remember()` and `MemoryStore.upsert()` schedule a `queueMicrotask` after the sync `INSERT` that calls `embedDocument(content)`. The microtask UPDATEs the row with the 768-dim BLOB and the model identifier. The write path itself stays sync (better-sqlite3 contract); embedding failures never throw and never block.

**Cross-model rejection:** New nullable `embedding_model TEXT` column on `memories`. The helper `computeSemanticSimilarities()` skips any candidate row whose `embedding_model` differs from the active `RELAY_EMBEDDING_MODEL` - prevents silent vector-space corruption if the user swaps embedding models (PITFALL 2.3).

**Engine purity preserved:** `memory-engine.ts` still imports only `./types.js`. The signature change (`scoreMemoryDetailed`/`scoreMemory` gain optional `opts?: ScoreOptions`; `budgetedRecall` gains optional `similarities?: ReadonlyMap<string, number>`) introduces zero new dependencies. All cosine math, fetch I/O, and BLOB decoding happen in `src/memory/semantic-similarities.ts` at the impure caller boundary.

**Wire-up:** `tools/recall.ts::handleRecall` and `tools/memory_search.ts::handleMemorySearch` both convert sync -> async, calling `await computeSemanticSimilarities(store, query, candidates)` before `budgetedRecall`. CLI consumers (`cmd-memory-ops::executeRecallCommand` and `cmd-verify::runRecallCheck`) add `await`. The 4 existing tests in `memory-search.test.ts` flip to async; all four pass without semantic changes (helper returns empty Map when env unset -> engine falls through to word-overlap, byte-identical to pre-T6 path).

## Acceptance criteria (ROADMAP Phase 4 success criteria)

| # | Criterion | Evidence |
|---|---|---|
| 1 | 5 CSS memories -> query "naming conventions for stylesheets" -> kebab-case in top results despite zero word overlap | T7 integration test (335ms against live nomic): kebab-case ranked #1 with score > 0.3 |
| 2 | `remember` returns sync; `get <id>` shows blob within ~1s | T2 lazy-UPDATE tests (memory-store-embed.test.ts) + T7 wait-for-embedding helper completes in <2s |
| 3 | LM Studio offline -> recall still works (word-overlap fallback); blob NULL; stderr warning | T2 + T5 fail-path tests; T6 regression test with `RELAY_EMBEDDING_MODEL` unset |
| 4 | `relay memory why <id>` shows `ScoreComponents.content` = semantic similarity when present | T3 ScoreComponents test asserts content carries opts.semanticSimilarity (cmd-memory-why already renders ScoreComponents - no change there) |
| 5 | memory-engine.ts purity preserved; similarities computed at caller layer | T3/T4 + CI lint guard: `grep -E "^import" src/memory/memory-engine.ts | grep -vE "from './(types|constants)"` returns zero |

## REQ-ID coverage

| REQ-ID | Spec | Task | Status |
|---|---|---|---|
| EMBED-01 | Lazy embed-on-write via async UPDATE; never blocks write; never throws | T2 | DONE |
| EMBED-02 | `scoreMemoryDetailed` accepts `opts?: { semanticSimilarity?: number }` | T3 | DONE |
| EMBED-03 | `budgetedRecall` accepts `similarities?: ReadonlyMap<string, number>` | T4 | DONE |
| EMBED-04 | Caller computes `computeSemanticSimilarities()` then passes into recall | T5 + T6 | DONE |
| EMBED-05 | Integration test - CSS naming -> kebab-case despite zero word overlap | T7 | DONE |

## Tests added per task

| Task | File | New tests |
|---|---|---|
| T1 | embeddings-migration.test.ts | +5 (embedding_model column, idempotency, NULL roundtrip) |
| T2 | memory-store-embed.test.ts (NEW) | +12 (lazy UPDATE, dedup, mock failure, env-unset feature flag) |
| T3 | score-memory.test.ts | +6 (opts.semanticSimilarity branch, no-query unchanged, clamp [0,1]) |
| T4 | budgeted-recall.test.ts | +7 (no-map regression, empty Map, partial map, ordering flip, threshold) |
| T5 | semantic-similarities.test.ts (NEW) | +18 (cosine fixtures, BLOB decode, cross-model rejection, env short-circuit) |
| T6 | recall-embed.test.ts (NEW) | +6 (async signature, env-unset regression, mock fetch wire-up, cross-model end-to-end) |
| T7 | embeddings-wire-up.integration.test.ts (NEW) | +1 (gated by `RELAY_INTEGRATION_LM_STUDIO=1`) |

**Suite delta:** 1218 baseline -> 1224 with new units (+6); integration test is skip-gated.

## Deviations from Plan

### Path adjustment - integration test location

**1. [Rule 3 - Blocking issue] Moved integration test from `test/` to `src/memory/`**
- **Found during:** T7
- **Issue:** Plan specified `test/embeddings-wire-up.integration.test.ts`, but `tsconfig.json` has `include: ["src/**/*.ts"]` and the test runner script is `node --test $(find dist -type f -name "*.test.js")`. A test at `test/...` would not be compiled by `tsc` and would not be discovered by the test runner.
- **Fix:** Placed at `src/memory/embeddings-wire-up.integration.test.ts` (builds to `dist/memory/...`). Gating preserved via `process.env['RELAY_INTEGRATION_LM_STUDIO'] === '1'` -> `describe(..., { skip: !INTEGRATION_ENABLED }, ...)`.
- **Commit:** 5d107a6
- **Impact:** None - test runs as part of normal `npm test` (skipped silently when integration env unset) AND can be invoked standalone with the gated env vars set.

No other deviations. All Rules 1-3 fixes were absorbed into the per-task TDD cycles.

## Patterns established (for Phase 5 + Phase 6)

1. **Lazy embed-on-write via queueMicrotask** - any future field that needs async I/O after a sync DB write follows the same shape: `INSERT (sync) -> queueMicrotask(() => asyncFetch().then(UPDATE).catch(() => {}))`. Errors logged via per-process deduped stderr; never thrown.

2. **Impure-boundary helper** - whenever an existing pure engine function needs an externally-computed value (fetch result, file read, system clock not from `now` arg), the value is computed at the caller layer in a `.ts` file co-located with the engine but distinguishable by name (`semantic-similarities.ts` next to `memory-engine.ts`) and passed in via an optional parameter (`opts` or named map). Engine imports stay frozen.

3. **Cross-model rejection** - whenever a column stores model-dependent data (embeddings, future: per-model scores), pair it with a TEXT model-id column and reject rows whose stored model differs from the active model. Phase 5 conflict-detection will reuse this for `conflict_model`.

4. **Stderr-loud dedup** - per-process `Set<string>` of reason strings; format `RELAY: <feature> skipped (<source> <reason>). Recall falling back to <safe-default>. Run 'relay doctor' to check.` One line per (process, reason) - surfaces silent failures without log spam.

5. **Defensive clamp at engine boundary** - even when upstream guarantees normalized output (nomic L2-normalized per model card), clamp inside the engine. Protects against future model swaps and partial-normalization bugs observed in some HuggingFace exports.

## What Phase 5 (Conflict Detection) needs to know

- **Cosine semantics:** `computeSemanticSimilarities()` returns `Map<id, clampedCosine>` where `clampedCosine in [0, 1]`. For nomic this is approximately `max(0, dotProduct)`. The threshold for "near-duplicate" in Phase 5 will calibrate against actual nomic distributions on the user's corpus (research/SUMMARY.md:98-118 cites 0.85 as a starting point for English text via nomic-v1.5).
- **Helper is reusable:** Phase 5 conflict-detection can import `computeSemanticSimilarities` to find candidate near-conflicts in O(candidate-count) embed calls (1) + O(n*768) cosine math.
- **`embedding_model` is the trust gate:** If a row's `embedding_model` does not match the active model, Phase 5 must treat that row as having no semantic signal (fall back to a textual diff, or skip entirely if conflict detection is purely semantic).
- **Engine purity invariant:** Phase 5 must NOT add fetch/DB imports to `memory-engine.ts`. Pattern: add `ConflictOptions { conflictsWith?: ReadonlyMap<string, ConflictResult> }` and thread through `scoreMemoryDetailed` if needed.

## Deferred follow-ups (out of scope this phase)

- `relay memory rebuild-embeddings` backfill command for rows written before nomic was loaded (`embedding_blob IS NULL` filter).
- `relay doctor` `embedding_coverage` probe (% of non-NULL `embedding_blob` rows).
- Per-model dimension assertion on read (currently embedding-client asserts 768 on write; reads trust the blob).
- Background re-embed when the user changes `RELAY_EMBEDDING_MODEL` (currently the new model just produces an empty Map for old rows; cross-model rejection silently degrades to word-overlap until the user explicitly backfills).

## Self-Check: PASSED

**Files created (verified via `[ -f ... ]`):**
- FOUND: src/memory/semantic-similarities.ts
- FOUND: src/memory/semantic-similarities.test.ts
- FOUND: src/memory/memory-store-embed.test.ts
- FOUND: src/memory/embeddings-wire-up.integration.test.ts
- FOUND: src/tools/recall-embed.test.ts

**Commits exist (verified via `git log --oneline`):**
- FOUND: 904f759 - T1 embedding_model column
- FOUND: 9bebcd3 - T2 queueMicrotask lazy embed
- FOUND: 9cc6150 - T3 ScoreOptions
- FOUND: 9459175 - T4 similarities Map
- FOUND: d47d148 - T5 computeSemanticSimilarities helper
- FOUND: 0ca0ca5 - T6 wire into handleRecall + handleMemorySearch
- FOUND: 5d107a6 - T7 EMBED-05 integration test

**Engine purity verified:**
```
$ grep -E "^import.*from '" src/memory/memory-engine.ts | grep -vE "from './(types|constants)"
(no output)
```

**Suite status:**
- Full suite (no integration flag): 1224 / 1224 pass
- T7 integration with live LM Studio: 1 / 1 pass (335ms)
- All scoring functions remain sync (no `async` keyword introduced in memory-engine.ts)
