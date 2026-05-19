# Phase 4 Plan Verification — Embeddings Wire-Up

**Plan:** `04-embeddings-wire-up/PLAN.md`
**Verifier:** gsd-plan-checker (Opus 4.7)
**Date:** 2026-05-19

## Verdict

**PASS — execute.** All 5 ROADMAP success criteria are traceable to tasks. All 5 REQ-IDs (EMBED-01..05) covered. Engine purity invariant preserved with CI lint guard. Sync semantics for `remember()` and `getCandidates()` honored. No blocking issues; 2 minor recommendations below.

## Coverage Matrix — ROADMAP Phase 4 Success Criteria

| # | Criterion (ROADMAP:70-76) | Task(s) | Status |
|---|---|---|---|
| 1 | 5 CSS memories → "naming conventions for stylesheets" → "kebab-case" in top despite zero word overlap | T7 + T8 step 5 | COVERED |
| 2 | `remember` sync; `get <id>` shows blob within ~1s (lazy UPDATE) | T2 + T8 steps 3-4 | COVERED |
| 3 | LM Studio offline → recall works (word-overlap); blob NULL; stderr warning | T2 + T5 fail-paths + T8 steps 6-8 | COVERED |
| 4 | `relay memory why <id>` shows `ScoreComponents.content` = semantic similarity | T3 (ScoreComponents.content carries opts.semanticSimilarity) | COVERED |
| 5 | `memory-engine.ts` purity — no new imports; similarities computed at caller | T3/T4 + CI lint guard (§Pure-function preservation) | COVERED |

## REQ-ID Coverage

| REQ-ID | Spec | Task(s) | Notes |
|---|---|---|---|
| EMBED-01 | Lazy embed-on-write via async UPDATE; never blocks write; never throws | T2 | `queueMicrotask` + private `updateEmbedding` + dedup warn |
| EMBED-02 | `scoreMemoryDetailed` accepts `opts?: { semanticSimilarity?: number }` | T3 | Defensive clamp [0,1]; no-query branch preserved |
| EMBED-03 | `budgetedRecall` accepts `similarities?: ReadonlyMap<string, number>` | T4 | `ReadonlyMap` (engine never mutates) |
| EMBED-04 | Caller computes `computeSemanticSimilarities()` then passes into recall | T5 (helper) + T6 (wire 4 sites) | cmd-memory-ops + cmd-memory-search + memory_search MCP + recall MCP |
| EMBED-05 | Integration test — CSS naming → kebab-case despite zero word overlap | T7 | `describe.skipIf` gated; T8 manual mirror |

**Coverage: 5/5 — no orphans.**

## Risk Coverage

| Required risk | Plan §Risk register | Verdict |
|---|---|---|
| Silent NULL fallback (PITFALL 2.4) | Row 1 — stderr-loud + deduped + doctor follow-up | COVERED |
| Dimension mismatch / model swap (PITFALL 2.3) | Row 2 — `embedding_model` column + cross-model rejection | COVERED |
| Async race in tests | Row 3 — `queueMicrotask` (not `setImmediate`) + single-tick flush | COVERED |
| Engine purity erosion (PITFALL 2.1) | Row 4 — CI grep lint; P0 if violated | COVERED |
| `handleMemorySearch` sync→async breaks callers | Row 5 — T6 verifies all callers already await | COVERED |
| LM Studio bug #1546 (`usage.*` unreliable) | Row 6 — embedding-client already ignores `usage.*` | COVERED |
| Big-endian platform corrupts BLOB | Row 7 — assert at module load (shipped) | COVERED |

**Coverage: 7/7 — all five required risks present plus 2 supplementary.**

## Purity Preservation Check

**Baseline verified:**
```
$ grep "^import" src/memory/memory-engine.ts
import type { Memory, MemoryType, ScoredMemory, RecallQuery, RecallResult } from './types.js';
import { TYPE_WEIGHTS, DECAY_HALF_LIFE_DAYS } from './types.js';
```
Only `./types` imported. (Plan says "`./types` + `./constants`" — `./constants` doesn't currently exist; either the plan's grep needs to accept `./types` only, or a `./constants` extraction is implied later. **Minor — see Recommendation 1.**)

**Plan invariants:**
- T3 GREEN: "NO new imports — `ScoreOptions` defined in-file"
- T4 GREEN: "No other changes"
- CI lint: `grep -E "^import.*from '" src/memory/memory-engine.ts | grep -vE "from './(types|constants)"` must return zero
- Executor MUST run grep after T3+T4 before marking complete

**Verdict: PRESERVED.** No IO/fetch/DB inside scoring functions. `scoreMemoryDetailed`/`scoreMemory`/`budgetedRecall` remain sync. Similarities computed in `src/memory/semantic-similarities.ts` (impure boundary) and passed in via `opts`/`ReadonlyMap`.

## Sync Semantics Check

| Function | Required state | Plan honors |
|---|---|---|
| `MemoryStore.remember()` | Returns string sync (no await) | T2 — `queueMicrotask` AFTER sync INSERT |
| `MemoryStore.upsert()` | Same sync semantics | T2 — mirrored |
| `MemoryStore.getCandidates()` | Sync (better-sqlite3) | NOT modified; verified line 585 still sync |
| `scoreMemory[Detailed]`, `budgetedRecall` | Sync | T3/T4 — no `async` keyword introduced |
| `handleMemorySearch` | Currently sync → must become async | T6 — explicit conversion + caller audit |

**`queueMicrotask` chosen over `setImmediate`** — confirmed in T2 GREEN and Risk #3. Vitest event loop determinism preserved.

## Backward Compatibility Check

- `scoreMemory(m, q, now)` without opts → byte-identical pre-change (T3 RED regression)
- `budgetedRecall(memories, q, now)` without map → byte-identical (T4 RED regression)
- `budgetedRecall(memories, q, now, new Map())` → identical to no-map (T4 RED — guards against "safe" empty maps)
- `embedding_blob IS NULL` → word-overlap fallback (T5 GREEN: empty Map → engine falls through to `computeContentScore`)
- LM Studio offline → empty Map + deduped warning; recall still returns (T5 RED + T6 RED regression guard)
- `RELAY_EMBEDDING_MODEL` unset → feature off; zero embed calls; no warnings (T2 RED + T5 RED)
- Cross-model `embedding_model` mismatch → row excluded from similarity Map (T5 RED)

## Pre-Conditions Verified

- `src/memory/embedding-client.ts` SHIPPED — `embedDocument`/`embedQuery` exist; prefixes hardcoded (`search_document: ` :26, `search_query: ` :29); 768 dim asserted; LE host asserted at load; `usage.*` ignored
- `embedding_blob BLOB` shipped at `db-migrations.ts:98-100`
- `MemoryRow.embedding_blob: Buffer | null` shipped
- `embedding_model` column NOT yet present — T1 adds (confirmed)
- `cli.ts` already awaits memory dispatch handlers
- `tools/memory_search.ts:22` `handleMemorySearch` currently sync — T6 converts (confirmed)
- `MemoryStore.getCandidates` sync at `memory-store.ts:585` — preserved (confirmed)
- `src/tools/recall.ts` exists (1.9K) — T6 wiring applicable

## Untouched-File Check

`files_modified` list excludes:
- `src/workers/*` ✓
- `src/runtime/store/db.ts` ✓

Verified — no entry in §Files-to-touch nor §Task-breakdown touches these paths.

## Integration Test Wording Check

T7 query string: **"naming conventions for stylesheets"** (matches plan §truths + ROADMAP criterion 1)
Target memory: **"Prefer kebab-case for CSS classes (e.g. .nav-link not .navLink)"**
Zero-word-overlap claim verified: `{naming, conventions, stylesheets} ∩ {prefer, kebab, case, css, classes, nav, link, navlink} = ∅`.
Assertion includes `ScoreComponents.content > 0.5` — proves semantic ranking, not coincidence.

## Gaps

**None blocking.** Two minor items:

1. **`./constants` doesn't exist in memory-engine.ts imports today.** The plan's CI lint accepts `./(types|constants)` but baseline only imports `./types`. If executor adds a `./constants` extraction during T3/T4, fine; otherwise the lint regex is harmlessly broader than needed.

2. **`relay doctor` embedding coverage check explicitly deferred.** Risk row 1 mentions it as follow-up. Acceptable for this phase since stderr-loud + per-process dedup covers the observability gap, but worth tracking in §Output deferred follow-ups (plan already does: line 481).

## Recommendations

1. **Tighten CI lint regex to match reality.** If `./constants` won't be added in Phase 4, change `from './(types|constants)` → `from './types'` in the lint command (§Pure-function preservation, line 412). Avoids future false-acceptance if a `constants` file is added unintentionally.

2. **T2 GREEN spec — confirm `warnedReasons` Set scope.** Plan says "module/instance scope" — pick one explicitly. Instance scope (per `MemoryStore` instance) is safer in test environments where multiple stores spawn; module scope matches `T5`'s helper-level dedup. Recommend **instance scope** for T2 (each `MemoryStore` has its own Set) and **module scope** for T5 (helper is stateless).

3. **T8 step 4 SQL.** Plan uses `sqlite3 .relay/relay.db` — ensure user has sqlite3 CLI installed; if not, suggest `relay memory get <id>` rendering blob length as a fallback indicator.

## Final Status

**PASS — proceed to `/gsd-execute-phase 04-embeddings-wire-up`.**

8 tasks (T1-T7 TDD + T8 checkpoint). Scope within budget (16 files, 7 implementation tasks). Engine purity guarded by CI lint. All 5 ROADMAP criteria + 5 REQ-IDs traceable. Risk register complete.
