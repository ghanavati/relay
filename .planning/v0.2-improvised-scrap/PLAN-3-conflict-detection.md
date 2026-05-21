# PLAN-3 — Conflict Detection in Memory Recall

**ROADMAP §4** | **Depends on:** PLAN-4-embeddings.md (post-#4 cosine gate). PLAN-3 ships first in `ANNOTATE_BOTH` mode without the gate; T6 lands once PLAN-4's `embedding_blob` column exists. | **Mode:** TDD strict, no codex.

Anchors: `src/memory/memory-engine.ts:195` (`budgetedRecall`), `src/memory/memory-store.ts:273` (`remember`), `src/memory/db-migrations.ts:65-93` (PRAGMA pattern), `src/context/layers.ts:252-258` (render prefix).

---

## Goal

At **write time** in `MemoryStore.remember()`, detect candidate conflicts (`tag_jaccard > 0.5` ∧ `content_jaccard < 0.3` ∧ `|T_new ∩ T_c| >= 2`) against same-workdir, same-`memory_type`, non-superseded memories. Store the conflicting `memory_id`s in a new `conflicts_with_json` column **reciprocally** (per the A-MEM lesson — `DELTA-MEM-CONFLICT.md:67-68`).

At **recall time**, between sort and budget-pack in `budgetedRecall`, run a single O(K²) pairwise pass over `K ≤ 32` candidates. When two conflicting memories are both candidates, apply precedence `trust_level → score (Δ > 0.1) → recency`, mark the loser, and (default `ANNOTATE_BOTH`) inject the loser with `⚠ CONFLICTS WITH #N:` rather than dropping it. Pinned memories are never dropped — only annotated (`DELTA-MEM-CONFLICT.md:262`).

Backward compatible: missing column or empty `conflicts_with_json` → no conflict signal, normal behavior. Workdir-scoped only.

---

## Files to touch

| File | Why |
|---|---|
| `src/memory/db-migrations.ts:65-93` | Add PRAGMA-guarded `ALTER TABLE memories ADD COLUMN conflicts_with_json TEXT NOT NULL DEFAULT '[]'` (mirrors `sources_json`/`files_json` shape per `MEMORY-MAP.md:139-145`). |
| `src/memory/types.ts:31-53` (`MemoryRow`), `:55-75` (`Memory`) | Add `conflicts_with_json: string` (DB) + `conflicts_with: readonly string[]` (domain). |
| `src/memory/memory-store.ts:78` (`rowToMemory`) | Parse `JSON.parse(row.conflicts_with_json ?? '[]')` with try/catch fallback to `[]`. |
| `src/memory/memory-store.ts:315-344` (`remember` INSERT) | Add column + value (default `'[]'`); reciprocal update path after insert. |
| `src/memory/memory-store.ts:411-439` (`upsert` INSERT) | Same column; supersession path means newer entity_key always wins — DO NOT cross-conflict against the row being superseded. |
| `src/memory/memory-engine.ts` (NEW exports + `budgetedRecall:195`) | Pure helpers `tagJaccard`, `contentJaccard`, `isConflictCandidate`; pairwise pass inserted after sort, before budget loop. |
| `src/memory/conflict-thresholds.ts` (NEW) | Centralized constants per `DELTA-MEM-CONFLICT.md:232-237`. |
| `src/context/layers.ts:252-258` | Loser annotation: prepend `⚠ CONFLICTS WITH #N: ` (using 1-based recall index of the winner). |
| `src/tools/memory_search.ts:49-58`, `src/tools/recall.ts:28` | Expose `conflicts_with` array in MCP response so the LLM can see it. |
| Tests (T1–T7 below). | TDD strict. |

**Will NOT touch:** `consolidation.ts` (uses tag-intersection count, NOT Jaccard per ROADMAP-DRIFT §5 — out of scope here); `MemoryStore.consolidate()`; FTS schema; trust derivation; eviction policy. The `jaccard` helper at `memory-store.ts:178` is module-private — **add new pure helpers to `memory-engine.ts`** to keep them importable, reusable, and aligned with engine purity (no IO).

---

## Task breakdown (TDD — RED → GREEN → REFACTOR each)

### T1 — Schema migration + type plumbing

- **RED**: Add test `src/memory/db-migrations.test.ts` asserting `PRAGMA table_info(memories)` contains `{name: 'conflicts_with_json', type: 'TEXT', notnull: 1, dflt_value: "'[]'"}` after `migrateMemoryTables(db)` on a fresh DB AND on a DB pre-seeded with the old schema (idempotency).
- **GREEN**: Insert PRAGMA-guarded ALTER block at `src/memory/db-migrations.ts:91` (just before `files_json` block) following the exact pattern at `:69-89`. Extend `MemoryRow` (`types.ts:31`) with `conflicts_with_json: string`; extend `Memory` (`types.ts:55`) with `conflicts_with: readonly string[]`. Update `rowToMemory` (`memory-store.ts:78`) with safe `JSON.parse(row.conflicts_with_json ?? '[]')` returning `[]` on parse error (Coding-Style: validate at boundaries).
- **Verify**: existing `db-migrations.test.ts` cases still green; `tsc --noEmit` passes.
- **Done**: Column present on fresh + migrated DBs, type extension propagates without breaking `SELECT *` consumers (all 9 listed in `MEMORY-MAP.md:281-289`).

### T2 — Pure helpers in `memory-engine.ts`

- **RED**: New `src/memory/conflict-detection.test.ts` covering:
  - `tagJaccard(['a','b','c'], ['a','b'])` → `2/3 ≈ 0.667`
  - `tagJaccard([], [])` → `0` (avoid NaN; matches `memory-store.ts:179`)
  - `contentJaccard("use kebab-case for css classes", "prefer camelCase for all identifiers")` → low (≤ 0.3)
  - `contentJaccard("use kebab-case for css classes", "use kebab-case for css names")` → high (> 0.7) — proves the DUPLICATE branch
  - `isConflictCandidate(m_a, m_b, thresholds)` table-driven: 4 cases from `DELTA-MEM-CONFLICT.md:122-125` (CONFLICT, DUPLICATE, UNRELATED, near-miss with `|T∩T'|=1`)
- **GREEN**: Add to `src/memory/conflict-thresholds.ts` (NEW):
  ```
  CONFLICT_TAG_JACCARD_MIN  = 0.5
  CONFLICT_CONTENT_JAC_MAX  = 0.3
  CONFLICT_MIN_SHARED_TAGS  = 2
  RECALL_PAIRWISE_K_CAP     = 32
  ```
  Add to `memory-engine.ts` (top-level, before `computeContentScore`):
  - `tokenizeForConflict(s: string): ReadonlySet<string>` — reuses `/[\W_]+/`, lowercase, `len ≥ 3` (matches `memory-store.ts:173`).
  - `jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number` — port from `memory-store.ts:178`; pure.
  - `tagJaccard(tagsA: readonly string[], tagsB: readonly string[]): number` — wraps `jaccard` over `new Set`s.
  - `contentJaccard(a: string, b: string): number` — `jaccard(tokenizeForConflict(a), tokenizeForConflict(b))`.
  - `isConflictCandidate(a: Pick<Memory,'tags'|'content'|'memory_type'>, b: Pick<…>, t: typeof THRESHOLDS): boolean` — gates on same `memory_type` (`DELTA-MEM-CONFLICT.md:226`), shared-tag count ≥ `min_shared_tags`, `tagJaccard > min`, `contentJaccard < max`.
  - All exports are pure, IO-free, no `Date.now()`, no DB reads.
- **Done**: 4 classification cases pass; helpers exported; no `MemoryStore` import inside `memory-engine.ts` (preserves dependency direction).

### T3 — `MemoryStore.remember()` write-time conflict scan

- **RED**: `src/memory/memory-store.conflict.test.ts`:
  - Write A `"use kebab-case for CSS classes"` tags `['css','naming','style']` workdir `/w`.
  - Write B `"prefer camelCase for all identifiers"` tags `['css','naming','identifiers']` workdir `/w`.
  - Assert: `getMemory(B).conflicts_with === [A.memory_id]` AND `getMemory(A).conflicts_with === [B.memory_id]` (reciprocal).
  - Workdir negative: same pair across `/w1` vs `/w2` → no conflict recorded.
  - `memory_type` mismatch (`fact` vs `decision`) → no conflict.
  - `|T_new ∩ T_existing| === 1` → no conflict (false-positive mitigation).
  - 60s content-hash dedup path (`memory-store.ts:295-302`) → returns early, no scan attempted.
  - Rate-limit path (`assertWriteRateLimit:251`) → throws before scan.
- **GREEN**: Inside `remember` after the INSERT (`memory-store.ts:344`) and before `gcByTokenBudget` (`:346`), add a **transactional** conflict-detection block:
  1. Skip if `mergedTags.length < CONFLICT_MIN_SHARED_TAGS` (cheap early exit).
  2. SQL prefilter using `json_each` (per `DELTA-MEM-CONFLICT.md:106`, requires SQLite json1 — already used in codebase):
     ```sql
     SELECT memory_id, content, tags_json, conflicts_with_json
     FROM memories
     WHERE superseded_by IS NULL
       AND memory_id != ?
       AND memory_type = ?
       AND workdir IS ?           -- workdir-scoped only; '?' bound to params.workdir (or NULL)
       AND EXISTS (
         SELECT 1 FROM json_each(memories.tags_json)
         WHERE json_each.value IN (<placeholders for T_new>)
       )
     ```
     Parameter-bind `T_new` defensively (Coding-Style: validate boundaries — no string interp into SQL).
  3. For each candidate row, parse `tags_json` (safe parse → `[]` on failure), call `isConflictCandidate(...)`.
  4. Collect `conflict_ids: string[]`.
  5. If non-empty: `UPDATE memories SET conflicts_with_json = ? WHERE memory_id = ?` on the new row, AND for each `cid` perform an **immutable append**: parse existing array, dedupe-append `memoryId`, write back (NO `json_insert` SQL — keeps logic in TS and unit-testable; aligns with global immutability rule).
  6. Wrap steps 2–5 in `this.db.transaction(() => { … })()` so the new row + reciprocal updates commit atomically (matches `upsert`'s pattern at `memory-store.ts:379`).
- **Verify**: 972 existing tests still green; new tests pass.
- **Done**: Reciprocal updates atomic; no scan when shared-tag floor not met; workdir + type scoping enforced at SQL.

### T4 — `budgetedRecall` pairwise pass

- **RED**: Append cases to `src/memory/budgeted-recall.test.ts`:
  - Two `trusted`-vs-`unverified` memories with mutual `conflicts_with`, both above `MIN_RELEVANCE_SCORE` → trusted wins; unverified marked as loser (presence of loser depends on mode — see T5).
  - Trust tie, score Δ > 0.1 → higher score wins.
  - Trust + score tie (`Δ ≤ 0.1`) → newer `accessed_at` wins.
  - Pinned loser is NEVER dropped (only annotated) — per open-question resolution in `DELTA-MEM-CONFLICT.md:262`.
  - Conflict references a memory NOT in current candidate set → no-op (don't pull external rows in).
  - K > 32 candidates → cap to top 32 (by score) for pairwise check; below-cap memories still budget-packed normally.
  - Empty/missing `conflicts_with` → behavior identical to today (regression guard against existing 5 budgeted-recall tests).
- **GREEN**: Modify `memory-engine.ts:195`. After the existing sort (`:202`) and `candidates` filter (`:208`) but BEFORE the greedy budget loop (`:215`):
  1. Take `top = candidates.slice(0, RECALL_PAIRWISE_K_CAP)` (O(K²) bound).
  2. Build `candidateIdSet = new Set(top.map(m => m.memory_id))`.
  3. Iterate `top` in sorted (score-DESC) order. For each `m`, parse `m.conflicts_with` (already on `Memory` from T1):
     - For each `cid ∈ m.conflicts_with` that is in `candidateIdSet` and not yet decided:
       - `[winner, loser] = rankPair(m, other, query, now)` — pure helper, also exported for testability.
       - Record decision in `decisions: Map<id, {role:'winner'|'loser', counterpart_id:string}>`.
  4. `rankPair` precedence per `DELTA-MEM-CONFLICT.md:191-198`:
     - Trust order `trusted > provisional > unverified` (lift from `types.ts:19`).
     - Tie → score (Δ > 0.1).
     - Tie → `accessed_at DESC`.
     - All ties → `memory_id` lex (deterministic; tests need this).
  5. Default mode `ANNOTATE_BOTH`: do NOT drop. Attach annotation metadata to `ScoredMemory` (new optional field `conflict_annotation?: { counterpart_id: string }`).
  6. Mode hook: read `query.conflict_resolution?: 'annotate' | 'drop'` (extend `RecallQuery` in `types.ts:88-99`); on `'drop'` set `dropSet`. Pinned memories are never added to `dropSet` regardless of mode.
  7. Greedy budget loop (`:215-222`) skips memories in `dropSet`. Backfill is **automatic** because we iterate `candidates` (not just non-losers) — the next-best loser-displaced memory simply takes the slot per the open-question resolution in `DELTA-MEM-CONFLICT.md:264`.
- **Done**: 4 new test cases pass; existing 5 cases unchanged; no regression to `scoreMemory` purity.

### T5 — Render-path annotation (loser injection)

- **RED**: `src/context/layers.conflict.test.ts`:
  - Two memories returned by `budgetedRecall`, loser has `conflict_annotation`. Render output contains `⚠ CONFLICTS WITH #1: ` prefix on the loser's line (or `#N` referring to the winner's 1-based position).
  - No annotation set → render identical to today.
  - Loser is also `unverified` → both prefixes compose: `[UNVERIFIED] ⚠ CONFLICTS WITH #N: …`.
  - Loser is `failure`-tagged → composes with `⚠ FAILED: ` similarly.
- **GREEN**: In `src/context/layers.ts:252-258`, extend the prefix builder:
  - Build a `memoryIdToIndex` map from the sorted list (`sorted[i].memory_id → i+1`).
  - When `memory.conflict_annotation?.counterpart_id` is present and the counterpart is in the rendered list, prepend `⚠ CONFLICTS WITH #${index}: `. If counterpart not in list (edge case after sort/filter), omit annotation silently (don't fabricate references).
  - Compose with existing `[UNVERIFIED]` / `⚠ FAILED:` prefixes (order: `[UNVERIFIED]` → `⚠ FAILED:` → `⚠ CONFLICTS WITH #N: ` → content).
- **Verify**: `loadRecalledLessonsContent` callers unaffected (env-gated `RELAY_RECALLED_LESSONS`).
- **Done**: Annotation visible to the worker; render is a pure function of `RecallResult`.

### T6 — Post-PLAN-4 embedding gate (LANDS ONCE PLAN-4 SHIPS)

- **Precondition gate**: Skip this task if `embedding_blob` column does not exist on `memories` (check via `PRAGMA table_info`). PLAN-3 ships without it; T6 is enabled in a follow-up commit once PLAN-4 lands.
- **RED**: Extend `src/memory/conflict-detection.test.ts` with cases that exercise embeddings:
  - Both memories have `embedding`, cosine ≥ 0.7 → NOT a conflict even if tag/content thresholds match (false-positive mitigation per `DELTA-MEM-CONFLICT.md:228`).
  - Both have embedding, cosine < 0.7 → conflict confirmed.
  - One or both lack embedding → fall through to existing tag/content heuristic (backward compatibility).
- **GREEN**: Extend `isConflictCandidate` signature with optional `embeddingSim?: number | null`. If non-null AND ≥ `EMBEDDING_CONFLICT_COS_MAX` (= 0.7), return `false`. Engine purity preserved — caller (T3 conflict scan in `remember`) computes cosine from the cached embeddings on both rows (when both `embedding_blob` non-null) and passes it in. The threshold lives in `conflict-thresholds.ts`.
- **Done**: With PLAN-4 shipped, false-positive rate drops; without PLAN-4, behavior unchanged.

### T7 — False-positive mitigation regression tests

- **RED**: `src/memory/conflict-false-positive.test.ts`:
  - Similar tags + similar content (paraphrase) → NOT a conflict (DUPLICATE branch, returns `false` from `isConflictCandidate`).
  - Similar tags + unrelated content with only 1 shared tag → NOT a conflict (shared-tag floor).
  - Cross-workdir same content with all tags shared → NOT a conflict (workdir scoping at SQL).
  - Cross-`memory_type` same content+tags → NOT a conflict (`memory_type` gate).
  - Production "docker compose for prod" vs local "docker compose for dev" with shared tags `['docker','compose']` → marked CONFLICT under heuristic, but T6 cosine gate (when embeddings present) suppresses it.
- **GREEN**: No new code — these are negative-case assertions over T2/T3 logic.
- **Done**: All four mitigation rails verified.

---

## Acceptance criteria

- Test (T3): write A "use kebab-case CSS" + tags `[css,naming,style]`, write B "prefer camelCase identifiers" + tags `[css,naming,identifiers]` (same workdir) → `getMemory(A).conflicts_with` and `getMemory(B).conflicts_with` each contain the other's ID; mutual update is **atomic** (assert by inspecting both rows inside one read).
- Recall (T4): both candidates above `MIN_RELEVANCE_SCORE`, A is `trusted` and B is `unverified` → A's render position is unchanged, B's render line is prefixed with `⚠ CONFLICTS WITH #${index_of_A}: `.
- Recall mode `'drop'`: same setup, B is excluded from `RecallResult.memories`; if B was pinned, B is still present and annotated (never dropped).
- All **972 existing tests pass** (`pnpm test` — no behavioral regression in scoring, recall, render, or migration).
- New conflict tests cover precedence rules (trust → score Δ>0.1 → recency → id-lex tiebreak) and at least the 5 false-positive negatives in T7.
- TypeScript: `tsc --noEmit` clean; no `any`; `Memory`/`MemoryRow` extensions documented inline; no `console.log` introduced (global hooks rule).
- Coverage: new files `conflict-thresholds.ts`, conflict-related helpers in `memory-engine.ts`, and the pairwise pass each ≥ 80% line coverage.

---

## Runtime validation

```
relay memory remember "use kebab-case for CSS classes" \
  --tags css,naming,style --workdir /tmp/conflict-test
relay memory remember "prefer camelCase for all identifiers" \
  --tags css,naming,identifiers --workdir /tmp/conflict-test
relay memory recall "css naming" --workdir /tmp/conflict-test --json
# Expect: two memories returned; the lower-trust/lower-score one carries
# conflict_annotation referencing the other's memory_id.

relay memory why <loser_id> --json
# Expect: ScoreComponents unchanged (conflict is pairwise, not unary), and
# `conflicts_with` array contains <winner_id>.

# Negative: cross-workdir isolation
relay memory remember "use tabs" --tags style,whitespace --workdir /tmp/wA
relay memory remember "use spaces" --tags style,whitespace --workdir /tmp/wB
relay memory recall "whitespace" --workdir /tmp/wA --json
# Expect: only the /tmp/wA memory; no annotation; conflicts_with == [].
```

---

## Risk register

| Risk | Mitigation |
|---|---|
| **False positives** on legitimate-but-different memories sharing tags. | (a) Shared-tag floor ≥ 2 (T2). (b) `memory_type` gate (T2). (c) Workdir SQL scoping (T3). (d) Post-PLAN-4 cosine gate (T6). (e) Default `ANNOTATE_BOTH` — false positive degrades to a `⚠` line, never silent drop (`DELTA-MEM-CONFLICT.md:229`). |
| **O(K²) at recall** balloons context cost. | Cap K at 32 (`RECALL_PAIRWISE_K_CAP`); 1024 ID comparisons ≈ sub-millisecond per `DELTA-MEM-CONFLICT.md:213`. |
| **Write-time scan latency** on large stores. | SQL prefilter via `json_each` cuts N to typically <50; tokenize + jaccard ~5ms for N=50 (`DELTA-MEM-CONFLICT.md:209`). If RELAY_MEMORY count > 100k, add `idx_memories_workdir_type` later (out of scope). |
| **Migration backfill**: existing rows get `'[]'` default. | Accepted — no historical conflict detection (`DELTA-MEM-CONFLICT.md:248`). Future `relay memory rescan-conflicts` CLI deferred to v0.3. |
| **Workdir-IS-NULL global memories** vs workdir-scoped. | T3 query uses `workdir IS ?` — when params.workdir is null, only matches other null-workdir rows; when set, only matches same workdir. **No cross-workdir conflict detection.** Resolves open-question 3 (`DELTA-MEM-CONFLICT.md:263`). |
| **Reciprocal-update race** under concurrent writes. | Wrap the new-row INSERT + candidate scan + reciprocal updates in a single `db.transaction(...)` (matches `upsert` pattern, `memory-store.ts:379`). better-sqlite3 is single-writer; transaction semantics preserve atomicity. |
| **Pinned-memory drop bug**. | T4 explicitly asserts pinned-never-dropped; render-time check is a safety net. |
| **`conflicts_with_json` JSON parse failure** on corrupt row. | `rowToMemory` (T1) uses try/parse → `[]` fallback. No crash. |
| **MCP response bloat** if a memory has many conflicts. | Cap the array displayed in `memory_search.ts`/`recall.ts` responses to 5; full list still queryable via `get_memory`. |
| **PLAN-4 dependency slip**: T6 cannot land. | T6 is independently gated; PLAN-3 ships without it. False-positive rate measured on real recall logs; if >5% before PLAN-4, raise `CONFLICT_MIN_SHARED_TAGS` to 3 as a stop-gap. |
| **Hidden mutation via `Memory.conflicts_with`**. | Field typed `readonly string[]`; parsed array is fresh from JSON.parse (no shared reference); reciprocal updates re-serialize a new array (Coding-Style: never mutate existing objects). |

---

## Notes on dependency direction & purity

- `memory-engine.ts` stays IO-free. All DB reads happen in `MemoryStore` (T3). Engine functions take `Memory[]` and return `RecallResult` plus annotation metadata — no `getDb()` import added.
- `conflict-thresholds.ts` is a pure constants module; no Zod schema needed (no untrusted input — values are compile-time literals).
- `consolidation.ts` is intentionally **untouched**. ROADMAP-DRIFT §5 confirms it uses tag-intersection count, not Jaccard; reworking it is out of scope for PLAN-3.
- The `rankPair` helper is exported from `memory-engine.ts` for unit-test isolation; `budgetedRecall` is the only production caller.