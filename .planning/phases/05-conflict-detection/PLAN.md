---
phase: 05-conflict-detection
plan: 01
type: tdd
wave: 1
depends_on: [04-embeddings-wire-up]
files_modified:
  - src/memory/db-migrations.ts
  - src/memory/types.ts
  - src/memory/memory-store.ts
  - src/memory/memory-engine.ts
  - src/memory/conflict-thresholds.ts
  - src/memory/conflict-detection.ts
  - src/context/layers.ts
  - src/tools/memory_search.ts
  - src/tools/recall.ts
  - src/cli/cmd-tui.ts
autonomous: true
requirements: [CONFLICT-01, CONFLICT-02, CONFLICT-03, CONFLICT-04, CONFLICT-05]

must_haves:
  truths:
    - "Two same-workdir lessons with overlapping tags but divergent content → both rows carry each other's IDs in conflicts_with_json (reciprocal, same transaction)."
    - "On recall, loser receives `⚠ CONFLICTS WITH #N` annotation instead of being dropped; pinned never dropped."
    - "Paraphrase with cosine ≥ 0.7 (post-EMBED) → NO conflict flagged."
    - "Cross-workdir pairs never flagged; detection SQL is strict `workdir = ?`."
    - "Pairwise pass capped at K=32 per recall; completes in <5ms on typical box."
    - "v0.1.2 → v0.2 DB upgrade safe — column default `'[]'` keeps legacy rows readable, recall behavior unchanged when conflict set empty."
  artifacts:
    - { path: "src/memory/conflict-thresholds.ts", provides: "TAG_JAC_MIN=0.5, CONTENT_JAC_MAX=0.3, MIN_SHARED_TAGS=2, COSINE_GATE_MAX=0.7, WRITE_CANDIDATE_CAP=50, RECALL_K_CAP=32" }
    - { path: "src/memory/conflict-detection.ts", provides: "Pure: tagJaccard, contentJaccard, isConflictCandidate, resolveConflicts. Imports only ./types, ./conflict-thresholds." }
    - { path: "src/memory/db-migrations.ts", provides: "PRAGMA-guarded ALTER adding `conflicts_with_json TEXT NOT NULL DEFAULT '[]'`", contains: "conflicts_with_json" }
    - { path: "src/memory/types.ts", provides: "MemoryRow.conflicts_with_json: string + Memory.conflicts_with: readonly string[] + RecallQuery.conflictPolicy (optional, default 'annotate') + ScoredMemory.annotations (optional)" }
    - { path: "src/memory/memory-store.ts", provides: "remember()/upsert() write-time detect + reciprocal UPDATE inside single db.transaction; private decodeEmbedding + cosine helpers" }
    - { path: "src/memory/memory-engine.ts", provides: "Two-pass budgetedRecall: pure scoreCandidates → pure resolveConflicts → pure packToBudget" }
    - { path: "src/context/layers.ts", provides: "Annotation prefix render with UUID→#N translation; combines with existing [UNVERIFIED] / ⚠ FAILED:" }
  key_links:
    - { from: "memory-store.ts remember()", to: "conflict-detection.ts isConflictCandidate", via: "called inside db.transaction(...) before gcByTokenBudget", pattern: "isConflictCandidate\\(" }
    - { from: "memory-engine.ts budgetedRecall", to: "conflict-detection.ts resolveConflicts", via: "between filter and greedy pack loop", pattern: "resolveConflicts\\(" }
    - { from: "context/layers.ts loadRecalledLessonsContent", to: "ScoredMemory.annotations", via: "prefix chain at layers.ts:252-259", pattern: "CONFLICTS WITH" }
    - { from: "db-migrations.ts migrateMemoryTables", to: "memories.conflicts_with_json", via: "PRAGMA table_info guard + ALTER", pattern: "conflicts_with_json" }
---

## Goal

Write-time conflict detection on `MemoryStore.remember()` + recall-time annotation in `budgetedRecall()`. Memories sharing tags but contradicting each other (tag_jaccard > 0.5, content_jaccard < 0.3, ≥2 shared tags) get mutually-reciprocal IDs stored in a new `conflicts_with_json` column. Recall does a pairwise pass after sort and before the greedy pack loop — loser gets `⚠ CONFLICTS WITH #N` (default `ANNOTATE_BOTH`). Cosine gate (post-Phase-4): when both peers have `embedding_blob`, require cosine < 0.7 to confirm — paraphrases never flag.

**Hard constraints (non-negotiable):**
- `memory-engine.ts` MAY ONLY import from `./types`, `./constants`, `./conflict-detection` (also pure). No DB/HTTP/fs/child_process (CC.4, PITFALLS 2.1).
- Workdir-scoped only. Detection SQL MUST be `workdir = ?` (strict equal), NEVER `workdir = ? OR workdir IS NULL` (CONFLICT-05, CC.3).
- Reciprocal updates happen inside the same `db.transaction(...)` block as the new-row INSERT (A-MEM lesson, DELTA-MEM-CONFLICT.md §4 W4).
- Pinned memories NEVER dropped, even under `drop-lower-trust` policy.
- Empty `conflicts_with_json` (default `'[]'`) preserves v0.1.2 → v0.2 behavior — recall unchanged for un-augmented rows.
- Detection at WRITE time vs ≤50 same-workdir candidates, NOT recall (DELTA-MEM-CONFLICT.md §8 #4, PITFALLS 3.1).
- If Phase 4 not shipped at execution time: drop T5 cosine gate, ship Jaccard-only, leave TODO sentinel; re-introduce when `embedding_blob` populated.

## Files to touch (with line ranges)

| File | Lines | Why |
|------|-------|-----|
| `src/memory/db-migrations.ts` | insert at `:101` (after `embedding_blob` ALTER, before POST_ALTER_DDL loop) | PRAGMA-guarded `ALTER TABLE memories ADD COLUMN conflicts_with_json TEXT NOT NULL DEFAULT '[]'` mirroring `sources_json`/`files_json` shape. |
| `src/memory/types.ts` | `:54` (MemoryRow), `:75` (Memory), `:80` (ScoredMemory), `:100` (RecallQuery) | Add `conflicts_with_json: string` to MemoryRow; `conflicts_with: readonly string[]` to Memory; optional `annotations?: readonly string[]` to ScoredMemory; optional `conflictPolicy?: 'annotate' \| 'drop-lower-trust' \| 'drop-all-conflicts'` (default `'annotate'`) to RecallQuery. |
| `src/memory/memory-store.ts` rowToMemory | `:78` | `JSON.parse(row.conflicts_with_json ?? '[]')` with try/catch → `[]` fallback. |
| `src/memory/memory-store.ts` remember INSERT | `:315-344` | Extend column list 18→19, append `conflicts_with_json` after `trust_level`. |
| `src/memory/memory-store.ts` upsert INSERT | `:411-439` | Same column-list extension for the transactional `upsert()` path (independent column list per MEMORY-MAP §7). |
| `src/memory/memory-store.ts` remember body | `:273-348` | Wrap INSERT + reciprocal UPDATE in a single `db.transaction(...)` (currently NOT transactional). Detection runs inside before `gcByTokenBudget()`. |
| `src/memory/conflict-thresholds.ts` | NEW | All threshold constants. No imports. |
| `src/memory/conflict-detection.ts` | NEW | Pure: `tagJaccard`, `contentJaccard`, `isConflictCandidate({tagJac,contentJac,sharedTagCount,cosine?})`, `resolveConflicts(scored, policy): {kept, annotations}`. Imports only `./types`, `./conflict-thresholds`. |
| `src/memory/memory-engine.ts` budgetedRecall | `:195-230` | Insert `resolveConflicts` between filter (`:208`) and pack loop (`:215`). Cap input to `RECALL_K_CAP=32`. Pinned always preserved. |
| `src/memory/memory-store.ts` cosine helpers | NEW near `:1300` | Private `decodeEmbedding(blob): Float32Array \| null` (defensive: null/length/finite checks) + `cosine(a,b): number`. |
| `src/context/layers.ts` | `:252-259` | Append `⚠ CONFLICTS WITH #N` to existing prefix chain (`[UNVERIFIED]`, `⚠ FAILED:`). UUID→#N translation via single lookup map over rendered list. |
| `src/tools/memory_search.ts` | `:38` (call site) | Additive — no signature change; `Memory[]` passed unchanged. |
| `src/tools/recall.ts` | `:28` | Additive — no behavior change unless caller opts in. |
| `src/cli/cmd-tui.ts` | `:89` | Additive — no behavior change unless caller opts in. |

## Task breakdown (TDD strict — RED → GREEN → REFACTOR per task)

> Interface-first: T1 schema, T2 pure helpers (stable contracts for T3/T4), T3 write, T4 recall, T5 cosine gate (post-Phase-4 augment), T6 render, T7 regression suite.

---

<task type="tdd" tdd="true">
  <name>T1: Migration — add `conflicts_with_json` column (PRAGMA-guarded)</name>
  <files>src/memory/db-migrations.ts, src/memory/conflict-migration.test.ts (NEW)</files>
  <behavior>
    - RED: New `src/memory/conflict-migration.test.ts` (mirror of `embeddings-migration.test.ts`):
      - asserts `migrateMemoryTables(freshDb)` produces a `conflicts_with_json` column type TEXT, NOT NULL, DEFAULT `'[]'`.
      - asserts running migration twice is idempotent (column appears exactly once).
      - asserts a row inserted before migration (legacy v0.1.2 fixture shape) reads back `conflicts_with_json === '[]'` after migration.
      - asserts INSERT of a row with explicit `conflicts_with_json='["abc","def"]'` round-trips intact.
    - GREEN: PRAGMA-guarded ALTER at `db-migrations.ts:101` (after `embedding_blob` ALTER, before `POST_ALTER_DDL` loop):
      `if (!existingCols.has('conflicts_with_json')) { db.prepare("ALTER TABLE memories ADD COLUMN conflicts_with_json TEXT NOT NULL DEFAULT '[]'").run(); }`
    - Backward-compat anchor: `NOT NULL DEFAULT '[]'` means legacy rows read-safe without backfill — `[]` = "no known conflicts" = current behavior.
  </behavior>
  <action>Implement test first; verify failure; add ALTER; verify pass. Do NOT alter `PRE_ALTER_DDL` — old DBs take the PRAGMA path, fresh DBs treat it as no-op after ALTER (matches `embedding_blob` precedent at db-migrations.ts:94-100).</action>
  <verify>
    <automated>npm test -- src/memory/conflict-migration.test.ts</automated>
  </verify>
  <done>Column present on fresh + legacy DBs; idempotent; default observable; JSON round-trip preserved.</done>
</task>

---

<task type="tdd" tdd="true">
  <name>T2: Pure helpers — `conflict-thresholds.ts` + `conflict-detection.ts`</name>
  <files>src/memory/conflict-thresholds.ts (NEW), src/memory/conflict-detection.ts (NEW), src/memory/conflict-detection.test.ts (NEW)</files>
  <behavior>
    - RED: `src/memory/conflict-detection.test.ts` exercises pure logic:
      - **tagJaccard**: `tagJaccard(new Set(['a','b']), new Set(['a','c']))` → `1/3`. Empty/empty → `0`. Disjoint → `0`. Identical → `1`.
      - **contentJaccard**: same shape over pre-tokenized sets (caller tokenizes via existing `tokenize` at memory-store.ts:173).
      - **isConflictCandidate** Jaccard-only mode (cosine undefined):
        - tag_jac=0.6, content_jac=0.2, sharedTags=2 → `true` (CONFLICT-02 baseline).
        - tag_jac=0.6, content_jac=0.5, sharedTags=2 → `false` (content too similar).
        - tag_jac=0.4, content_jac=0.2, sharedTags=2 → `false` (tag too low).
        - tag_jac=0.8, content_jac=0.1, sharedTags=1 → `false` (shared-tag floor; DELTA-MEM-CONFLICT.md §8 #1).
      - **isConflictCandidate** cosine-gated:
        - tag_jac=0.6, content_jac=0.2, sharedTags=2, cosine=0.6 → `true` (below 0.7).
        - tag_jac=0.6, content_jac=0.2, sharedTags=2, cosine=0.75 → `false` (paraphrase suppressed; CONFLICT-04, PITFALLS 3.5).
        - cosine undefined when both other inputs would otherwise flag → degrade to Jaccard-only (`true`); never block on missing data.
      - **resolveConflicts** policy='annotate':
        - A (score 0.9, trust 'trusted') and B (score 0.8, trust 'unverified') with mutual conflicts_with → both kept; A annotated `⚠ CONFLICTS WITH B`, B annotated `⚠ CONTRADICTED BY A`.
        - Precedence: trust_level → score → recency (DELTA-MEM-CONFLICT.md §6 `rank_pair`).
      - **resolveConflicts** policy='drop-lower-trust':
        - Same pair → A kept (no annotation), B dropped (absent from `kept`).
        - Pinned exception: if B pinned, survives with annotation regardless of policy.
      - **K cap**: input length > `RECALL_K_CAP=32` → only first 32 (by sort order) participate; remainder passes through unchanged (no annotation, no drop). Latency assertion: 32×32=1024 comparisons completes well under 100ms upper bound (CI-stable).
    - GREEN: Implement helpers. `tagJaccard`/`contentJaccard` are 8 lines each (mirror of existing `jaccard` at memory-store.ts:178 — do NOT re-export, keep store's private copy stable). `resolveConflicts`: build conflict_map by intersecting each row's `conflicts_with` with candidate ID set, walk score-DESC applying `rank_pair`.
    - REFACTOR: Lint check — `grep -n "import" src/memory/conflict-detection.ts` must show only `./types` and `./conflict-thresholds`. Confirm no `async`.
  </behavior>
  <action>Write all test cases first; stub helpers to fail; implement smallest correct version; verify import allowlist.</action>
  <verify>
    <automated>npm test -- src/memory/conflict-detection.test.ts</automated>
  </verify>
  <done>All 12+ cases pass; imports restricted; pairwise resolve well under 5ms target on K=32; no `async`.</done>
</task>

---

<task type="tdd" tdd="true">
  <name>T3: Write-time detection in `remember()` + reciprocal UPDATE in single transaction</name>
  <files>src/memory/memory-store.ts, src/memory/types.ts, src/memory/conflict-write.test.ts (NEW)</files>
  <behavior>
    - RED: `src/memory/conflict-write.test.ts`:
      - **Fixture pair (Phase-5 SC#1)**:
        - Insert A: `content="use kebab-case for CSS classes"`, `tags=["css","naming"]`, `workdir="/p"`, `memory_type="lesson"`.
        - Insert B: `content="prefer camelCase for all identifiers"`, `tags=["css","naming","style"]`, `workdir="/p"`, `memory_type="lesson"`.
        - Assert `getMemory(B).conflicts_with` includes `A.memory_id`.
        - Assert `getMemory(A).conflicts_with` includes `B.memory_id` (retroactive UPDATE — A was in DB when B arrived).
        - Assert both row `conflicts_with_json` columns are valid JSON arrays.
      - **Workdir isolation (CONFLICT-05)**: A in `/p1`, B (conflict-class) in `/p2` → neither references the other.
      - **Memory-type isolation (DELTA-MEM-CONFLICT.md §8 #3)**: A=`lesson`, B=`fact` with otherwise-conflict content → no conflict.
      - **Shared-tag floor (CONFLICT-02 ≥2)**: A `tags=["css"]`, B `tags=["css","naming"]` → no conflict even with low content_jac.
      - **Pinned protection scope (smoke)**: write A pinned, write conflict-class B → reciprocal IDs still recorded; pinned protection lives at RECALL not write.
      - **Same-transaction atomicity (PITFALLS 3.2)**: monkey-patch the reciprocal UPDATE to throw after INSERT. Assert BOTH the new INSERT and conflict computation rolled back (`count()` unchanged).
      - **Write candidate cap (PITFALLS 3.1, DELTA-MEM-CONFLICT.md §8 #4)**: seed 100 same-workdir/same-type rows with the conflict tag set; insert new conflict-class row; assert SQL prefilter LIMITs to `WRITE_CANDIDATE_CAP=50`; `conflicts_with` length ≤ 50.
      - **Skip when |T_new| < 2 (DELTA-MEM-CONFLICT.md §4 W1)**: insert row with 1 tag → no detection runs, no extra DB reads beyond INSERT.
    - GREEN:
      1. Convert `remember()` body (`memory-store.ts:273-348`) into `db.transaction(() => { ... })`. Inside: existing dedup + `assertWriteRateLimit` stay OUTSIDE (guards, not state mutations); INSERT with extended column list; if `mergedTags.length >= 2` run candidate query (workdir-strict, memory_type-strict, `superseded_by IS NULL`, tag-overlap via `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value IN (...))`), LIMIT `WRITE_CANDIDATE_CAP`; score via T2 helpers; cosine gate (T5 wires this); collect conflict IDs; UPDATE new row's `conflicts_with_json` AND for each peer: `UPDATE memories SET conflicts_with_json = json_insert(coalesce(conflicts_with_json,'[]'), '$[#]', ?) WHERE memory_id = ?` (exact pattern DELTA-MEM-CONFLICT.md §4 W4). Idempotency: check `conflicts_with_json LIKE ?` before insert to avoid duplicates on re-runs.
      2. Extend `upsert()` (`:360-455`) symmetrically — already transactional (`upsertTx` at `:379`). Conflict pass slots in after supersession scan, before `gcByTokenBudget()` epilogue.
      3. Update `rowToMemory` (`:78`) with `JSON.parse(row.conflicts_with_json ?? '[]')` + try/catch → `[]` fallback.
      4. Update `MemoryRow` and `Memory` interfaces in `types.ts`.
    - REFACTOR: Extract candidate-fetch + score loop into `private detectConflicts(newRow, mergedTags, workdir, memory_type): readonly string[]`. MUST only be called inside active transaction.
  </behavior>
  <action>RED first; convert remember() to transactional; implement detect+UPDATE; extend upsert(); update types + rowToMemory. T5 cosine gate is inert when both blobs are null — Phase-4-not-ready degrades silently.</action>
  <verify>
    <automated>npm test -- src/memory/conflict-write.test.ts src/memory/memory-store.test.ts</automated>
  </verify>
  <done>All test bullets pass; existing `memory-store.test.ts` green; reciprocal updates atomic with INSERT; cap=50 enforced; skip when |tags|<2.</done>
</task>

---

<task type="tdd" tdd="true">
  <name>T4: Recall-time pairwise pass + annotation in `budgetedRecall()`</name>
  <files>src/memory/memory-engine.ts, src/memory/types.ts, src/memory/conflict-recall.test.ts (NEW)</files>
  <behavior>
    - RED: `src/memory/conflict-recall.test.ts`:
      - **ANNOTATE_BOTH default (Phase-5 SC#2)**: Build `Memory[]` of 5 rows; rows 0 and 2 carry reciprocal `conflicts_with`; row 0 `trust_level='trusted'`, row 2 `'unverified'`. Call `budgetedRecall(memories, { query: 'css', token_budget: 10000 }, now)`. Expect both returned; row 0 annotated `⚠ CONFLICTS WITH <row-2-id>`, row 2 annotated `⚠ CONTRADICTED BY <row-0-id>`.
      - **drop-lower-trust**: same fixture with `conflictPolicy: 'drop-lower-trust'`. Expect row 2 absent and `omitted_count` incremented by 1.
      - **Pinned never dropped (Phase-5 SC#2, DELTA-MEM-CONFLICT.md §10 Q2)**: same fixture but row 2 pinned, policy `'drop-lower-trust'` → row 2 remains, annotated.
      - **K cap = 32 (Phase-5 SC#5)**: fixture of 50 memories with two mutual conflicts at sort positions 40 and 41. Default cap → fall outside the pairwise window → NO annotation. (If env override `RELAY_CONFLICT_K_CAP=64` is wired: assert annotation present; if const-only, document in CHANGELOG.)
      - **Empty conflicts_with**: all `conflicts_with=[]` → behavior bit-identical to pre-Phase-5 baseline (no annotation field set, `omitted_count` unchanged).
      - **Reference to absent ID (PITFALLS 3.2)**: row 0 `conflicts_with=[<deleted-id>]` → no throw, missing referent silently skipped, no annotation produced.
      - **Two-pass purity**: spy on `scoreCandidates` and `resolveConflicts` — each called exactly once per recall. `memory-engine.ts` import list excludes DB/HTTP/fs (grep check via `fs.readFileSync` + regex).
    - GREEN:
      1. Refactor `budgetedRecall` (`memory-engine.ts:195-230`) into three named blocks: `scoreCandidates(memories, query, now)` (extract `:196-202`), `resolveConflicts` imported from `./conflict-detection` (T2) called between filter (`:208`) and pack loop (`:215`), `packToBudget(kept, query.token_budget)` (extract `:210-222`). Exported `budgetedRecall` becomes 5-line orchestrator.
      2. Cap input to `resolveConflicts` to `RECALL_K_CAP=32` (top-32 by score); remainder of filtered list passes through to `packToBudget` un-annotated.
      3. Annotations: `ScoredMemory[]` from `resolveConflicts` carries `annotations: readonly string[]`. `packToBudget` preserves it; `RecallResult.memories` exposes it.
      4. Default `RecallQuery.conflictPolicy` to `'annotate'` if undefined.
    - REFACTOR: Confirm `memory-engine.ts` LoC delta is small (<60). Confirm no imports of `better-sqlite3`, `node:http`, `node-fetch`, or `../runtime/*`.
  </behavior>
  <action>Refactor in two passes: extract scoreCandidates/packToBudget (no behavior change), confirm existing `memory-engine.test.ts` green; THEN slot in `resolveConflicts` and add new test file. Isolates regressions to conflict pass.</action>
  <verify>
    <automated>npm test -- src/memory/conflict-recall.test.ts src/memory/memory-engine.test.ts</automated>
  </verify>
  <done>All cases pass; existing engine tests green; engine purity preserved; K=32 honored; pinned never dropped; absent-reference safe.</done>
</task>

---

<task type="tdd" tdd="true">
  <name>T5: Cosine gate at write time (post-EMBED augment)</name>
  <files>src/memory/memory-store.ts, src/memory/conflict-cosine.test.ts (NEW)</files>
  <behavior>
    - **Precondition probe (Phase-4 readiness)**: query the DB schema for `embedding_blob` AND confirm at least one memory has `embedding_blob IS NOT NULL` (proves Phase 4 live). If neither holds: skip with `// TODO PHASE-5: re-enable when Phase 4 lands` sentinel inside `detectConflicts`, add note to v0.2 known-issues, proceed to T6. If precondition holds: implement as below.
    - RED: `src/memory/conflict-cosine.test.ts`:
      - **Paraphrase suppression (CONFLICT-04, Phase-5 SC#3)**: seed two memories with tags `["css","naming"]`:
        - A: `"use kebab-case for CSS class names"`
        - B: `"prefer dash-separated identifiers when authoring stylesheets"`
        - Both `embedding_blob` populated with synthetic 768-dim vectors crafted so cosine ≈ 0.85 (above 0.7).
        - Insert A then B; assert NEITHER row's `conflicts_with_json` references the other. (Jaccard alone would have flagged; cosine gate suppresses.)
      - **True conflict survives**: same tags, semantically opposed:
        - A: `"use kebab-case for CSS class names"`
        - B: `"never use kebab-case in CSS; use camelCase everywhere"`
        - Synthetic embeddings cosine ≈ 0.4 (below 0.7). Assert reciprocal conflict IDs recorded.
      - **Mixed-presence fallback (EMBED-01 lazy-backfill case)**: A has `embedding_blob`, B NULL. Detection falls back to Jaccard-only — does NOT block on missing data, does NOT crash, logs no error to stderr.
      - **Decode safety**: Buffer length != 3072 → treat as missing. Buffer length 3072 but values not finite → treat as missing. Both fall back to Jaccard-only.
    - GREEN:
      1. Private `decodeEmbedding(blob: Buffer | null): Float32Array | null` on `MemoryStore` near `:1300`. Checks: null → null; length !== `EXPECTED_EMBEDDING_DIM * 4` → null; `new Float32Array(blob.buffer, blob.byteOffset, EXPECTED_EMBEDDING_DIM)`; all-finite check → else null.
      2. Private `cosine(a: Float32Array, b: Float32Array): number` 6-line helper near `decodeEmbedding`. nomic-embed-text-v1.5 vectors already L2-normalized per PITFALLS 2.5; defensively re-normalize for non-nomic edge cases.
      3. In `detectConflicts` (T3), after Jaccard verdict CONFLICT: if BOTH `newRow.embedding_blob` AND `candidate.embedding_blob` decode to non-null → compute cosine, gate `< COSINE_GATE_MAX=0.7`. If either side null from `decodeEmbedding` → Jaccard verdict stands.
    - REFACTOR: Helpers stay on `MemoryStore` (not in `memory-engine.ts` — purity). If future caller needs them, lift to `src/memory/embedding-similarity.ts` per PITFALLS 2.5.
  </behavior>
  <action>Run precondition probe first. If Phase 4 not ready: log skip + sentinel TODO + move to T6. If ready: write tests, implement decode+cosine, gate the verdict.</action>
  <verify>
    <automated>npm test -- src/memory/conflict-cosine.test.ts</automated>
  </verify>
  <done>Cosine gate active when both peers have embeddings; degrades to Jaccard-only when absent; decode-safe against malformed buffers; paraphrase suppression observable; true conflicts survive.</done>
</task>

---

<task type="tdd" tdd="true">
  <name>T6: Annotation rendering in `context/layers.ts`</name>
  <files>src/context/layers.ts, src/context/conflict-render.test.ts (NEW)</files>
  <behavior>
    - RED: `src/context/conflict-render.test.ts`:
      - Build a `RecallResult` fixture (post-T4 type) where row 0 (sorted index after the failure-first sort at `layers.ts:244-250`) carries `annotations=['⚠ CONFLICTS WITH <other-id>']`.
      - Invoke `loadRecalledLessonsContent` via `createRecalledLessonsLayerProvider` (or expose internals via test-only export — pick path with fewest churn). Expect rendered Markdown list to contain `1. ⚠ CONFLICTS WITH #2: use kebab-case…` where `#2` is the 1-based index of the conflicting peer in the rendered list, NOT the raw UUID.
      - **Index resolution**: annotation rewritten at render time — engine layer stores `⚠ CONFLICTS WITH <memory_id>` (UUID), render layer translates UUID → 1-based index within rendered list. If peer ID is not in the rendered list (filtered by `MIN_RELEVANCE_SCORE`), drop annotation gracefully — no dangling reference.
      - **Combination with existing prefixes**: `[UNVERIFIED]` + `⚠ CONFLICTS WITH #N` both render → `[UNVERIFIED] ⚠ CONFLICTS WITH #N: <content>`. `⚠ FAILED:` + `⚠ CONFLICTS WITH #N` → `⚠ FAILED: ⚠ CONFLICTS WITH #N: <content>`. No annotations + no markers → existing `${index + 1}. ${content}` output preserved bit-exact.
    - GREEN:
      1. Modify `layers.ts:252-259`. Compute `conflictPrefix` from `memory.annotations` (filter entries starting with `⚠`, translate inner UUIDs to `#N` using lookup built once from `sorted` array). Concatenate: `prefix = [unverifiedMarker, failureMarker, conflictPrefix].filter(Boolean).join(' ')`.
      2. Add `buildIdToIndexMap(sorted: readonly ScoredMemory[]): Map<string, number>` adjacent to render loop.
      3. Preserve existing failure-first sort (`:244-250`) — conflict markers are decoration on unchanged sort.
    - REFACTOR: No new imports beyond what's present — `ScoredMemory` already in scope via `RecallResult.memories`.
  </behavior>
  <action>Test first; implement index-translation lookup; verify combination cases; confirm no regression in existing `layers.test.ts`.</action>
  <verify>
    <automated>npm test -- src/context/conflict-render.test.ts src/context/layers.test.ts</automated>
  </verify>
  <done>Annotation surfaced as `⚠ CONFLICTS WITH #N: <content>`; dangling references silently dropped; combination with `[UNVERIFIED]` and `⚠ FAILED:` correct; existing layer tests green.</done>
</task>

---

<task type="tdd" tdd="true">
  <name>T7: False-positive mitigation + workdir-leak prevention regression suite</name>
  <files>src/memory/conflict-false-positives.test.ts (NEW), src/memory/conflict-workdir-isolation.test.ts (NEW)</files>
  <behavior>
    - RED: `src/memory/conflict-false-positives.test.ts` (DELTA-MEM-CONFLICT.md §8 + PITFALLS 3.5):
      - **Docker scope variation**: shared `["docker","compose"]`, one prod-deployment row, one local-dev row. With cosine ≥ 0.7 in fixtures: NO conflict. Without cosine (mixed-presence): conflict flagged (acceptable — explicitly documented limitation). Test asserts cosine-present path suppresses.
      - **Near-duplicate (DUPLICATE class, not CONFLICT)**: tag_jac > 0.5, content_jac > 0.7 → no conflict (defers to existing SHA dedup at memory-store.ts:295).
      - **Cross-memory_type**: same tags + low content_jac, A=`lesson` and B=`fact` → no conflict.
      - **Subtle wording variant**: "use kebab-case for CSS classes" vs "always use kebab-case for class names in CSS files" — token sets overlap moderately, cosine ≈ 0.92. Should NOT flag.
    - RED: `src/memory/conflict-workdir-isolation.test.ts` (CONFLICT-05, CC.3, PITFALLS workdir leak):
      - Write A in `/p1`, B (conflict-class) in `/p2` → both `conflicts_with` empty.
      - Write A in `/p` with `workdir=null` (global), B in `/p` (workdir-scoped) with conflict-class → no conflict — detection requires strict workdir equality, NEVER `workdir IS NULL OR workdir = ?`. (Explicit deviation from MEMORY-MAP's example W1 query, justified by CC.3 + Phase-5 SC#4.)
      - Recall in workdir `/p1` over memories from both `/p1` and `/p2` → returned set absent of `/p2` (already enforced by existing `buildWhereClause`; lock in via regression test).
      - Grep guard: scan `src/memory/conflict-detection.ts` and `src/memory/memory-store.ts` `detectConflicts` for substring `workdir IS NULL` — fail if found (forces strict-equal). Use `fs.readFileSync` + assert.
    - GREEN: Both test files target behavior implemented in T2/T3/T5 — green when those tasks honor the constraints. If failure, fix in the original task.
    - REFACTOR: None expected — guard tests.
  </behavior>
  <action>Write both regression files; run; expect green if T2/T3/T5 honored constraints, RED otherwise (which surfaces regression for fix in original task).</action>
  <verify>
    <automated>npm test -- src/memory/conflict-false-positives.test.ts src/memory/conflict-workdir-isolation.test.ts</automated>
  </verify>
  <done>False-positive suite green (paraphrase/duplicate/cross-type/wording-variant); workdir isolation absolute (no `workdir IS NULL` escape); grep guard against future regressions.</done>
</task>

## Acceptance criteria (one per ROADMAP Phase 5 success criterion)

1. **Reciprocal mutual conflict IDs in same transaction** (SC#1): T1 ships column; T3 wraps `remember()` in `db.transaction(...)`, runs detection, INSERTs + UPDATEs peers atomically. Verified by `conflict-write.test.ts` "Fixture pair" + "Same-transaction atomicity".
2. **Annotation default (`⚠ CONFLICTS WITH #N`), pinned never dropped** (SC#2): T4 default policy `'annotate'`; pinned bypass in `resolveConflicts`; T6 renders annotation. Verified by `conflict-recall.test.ts` ANNOTATE_BOTH + Pinned and `conflict-render.test.ts`.
3. **Cosine gate suppresses paraphrase false positives** (SC#3, CONFLICT-04): T5 gate active when both peers have `embedding_blob`, threshold `< 0.7`. Verified by `conflict-cosine.test.ts` Paraphrase Suppression + True Conflict Survives.
4. **Workdir-scoped only, no cross-workdir flag** (SC#4, CONFLICT-05): T3 candidate query strict-equal `workdir = ?`. Verified by `conflict-workdir-isolation.test.ts` cross-workdir + grep guard.
5. **K cap = 32 in pairwise pass** (SC#5, CONFLICT-03): T4 caps input to `RECALL_K_CAP=32`. Verified by `conflict-recall.test.ts` K cap + latency assertion.

## Runtime validation (end-to-end smoke after all 7 tasks green)

1. **Reset clean workdir DB**: `rm -rf .relay && relay info` (forces migration on fresh DB).
2. **Write two conflicting memories**:
   - `relay memory remember "use kebab-case for CSS classes" --tags css,naming --type lesson`
   - `relay memory remember "prefer camelCase for all identifiers" --tags css,naming,style --type lesson`
3. **Inspect direct DB row**: `sqlite3 .relay/relay.db "SELECT memory_id, content, conflicts_with_json FROM memories ORDER BY created_at DESC"` — expect mutually-referenced IDs.
4. **Recall both via search**: `relay memory search "css class naming" --token-budget 10000 --format json` — expect both returned; lower-trust/score entry's rendered content (or `annotations` field if exposed via JSON) carries `⚠ CONFLICTS WITH` marker.
5. **Render through agentic context (proves T6 wiring)**: `RELAY_RECALLED_LESSONS=1 relay run --task "show me css naming conventions"` — inspect `recalled_lessons` layer output; conflicting line begins with `⚠ CONFLICTS WITH #N`.
6. **Workdir leak smoke**: `cd /tmp/relay-test-a && relay memory remember "use tabs" --tags indent,style --type lesson; cd /tmp/relay-test-b && relay memory remember "use spaces" --tags indent,style --type lesson` — assert neither row references the other.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **False-positive flood** (DELTA-MEM-CONFLICT.md §8, PITFALLS 3.5) — Jaccard-only flags paraphrases | HIGH (without T5) → LOW (with T5) | MEDIUM — user trust erodes | T5 cosine gate primary; `MIN_SHARED_TAGS=2` floor secondary; if T5 cannot ship, ship with `ANNOTATE_BOTH` default (no drops) so false positives degrade to harmless `⚠` lines + document in CHANGELOG. |
| **O(K²) recall cost balloons** (PITFALLS 3.1) | LOW | LOW | Hard cap K=32 → max 1024 in-memory ID comparisons, sub-millisecond. Test asserts <100ms upper bound. |
| **Workdir leak** (CC.3, CONFLICT-05) — detection SQL forgets `WHERE workdir = ?` | LOW (with T7 guard) | HIGH — cross-project contamination | T7 grep guard against `workdir IS NULL` in detect path; T3 candidate query reviewed strict-equal; `assertWorkdirAllowed` already at `remember()` entry (memory-store.ts:288). |
| **Pinned memory dropped under drop-* policy** (DELTA-MEM-CONFLICT.md §10 Q2) | LOW (with T2 test) | MEDIUM — curated memory silently lost | T2 `resolveConflicts` test explicitly asserts pinned survives drop-lower-trust; T4 recall test confirms end-to-end. |
| **Migration backfill missing** (PITFALLS 2.2) — legacy rows crash on `JSON.parse(null)` | LOW | HIGH — recall throws on every old row | Column default `'[]'` (NOT NULL) means legacy rows read-safe immediately; `rowToMemory` adds `?? '[]'` fallback; T1 test inserts pre-migration row and asserts safe read after. |
| **Transaction rollback boundary erodes** (PITFALLS 3.2) — INSERT succeeds but UPDATE fails outside txn | LOW (with T3 atomicity test) | HIGH — stale references accumulate | T3 wraps remember() in `db.transaction(...)`; T3 atomicity test monkey-patches UPDATE to throw and asserts INSERT rolled back. |
| **Cosine compares vectors from different embedding models** (PITFALLS 2.3) | LOW (Phase 4 mitigates) | MEDIUM — false negatives/positives | Phase 4 introduces `embedding_model` discipline; Phase 5's `decodeEmbedding` defensively checks dimension (3072 bytes / 768 dims); mismatched length → treated as missing → Jaccard fallback. |
| **Engine purity erodes** (CC.4, PITFALLS 2.1) — `resolveConflicts` accidentally imports DB/HTTP | LOW (with T2 + T4 lint) | HIGH — caller refactor, test mocking explodes | T2 grep-restriction on `conflict-detection.ts`; T4 grep-restriction on `memory-engine.ts`; allowlist `./types`, `./constants`, `./conflict-thresholds`, `./conflict-detection`. |
| **Phase 4 not landed at Phase 5 start** | MEDIUM | LOW (with degradation plan) | T5 precondition probe; if Phase 4 absent, ship Jaccard-only with sentinel TODO + CHANGELOG note. Plan validity independent of Phase 4 wall-clock. |
| **`upsert()` write path forgotten** (MEMORY-MAP §7) | LOW (with T3 explicit step) | MEDIUM — `entity_key` supersessions miss detection | T3 GREEN step 2 explicitly extends `upsert()` column list + invokes `detectConflicts` inside existing `upsertTx`. |
| **Caller signature break** — 5 `budgetedRecall` consumers refactor cost | LOW | LOW | Plan additive: `Memory[]` input unchanged; `conflictPolicy` optional with `'annotate'` default; `RecallResult.memories[i].annotations` optional. No call site needs modification beyond T6 (renderer, not caller). |

## Out-of-scope (deferred to v0.3+)

- LLM-judge fallback for ambiguous pairs (Mem0 pattern) — only revisit if false-positive rate >5%.
- Pattern mining over the conflict graph (PaTeCon-style temporal constraints).
- User-facing `relay memory conflicts <id>` CLI subcommand (DELTA-MEM-CONFLICT.md §9).
- Periodic `relay memory consolidate --conflicts` cleanup pass (PITFALLS 3.2 #2).
- Env override for K cap (`RELAY_CONFLICT_K_CAP`) — implement as const-only in v0.2 if test-fixture wiring is the only blocker.

## Files explicitly NOT touched

- `src/workers/*` — Phase 3 territory.
- `src/cli/cmd-budget.ts` — Phase 2 territory.
- `src/runtime/store/db.ts` — Phase 1 territory; this plan only adds PRAGMA-guarded ALTER in `db-migrations.ts`.
- `src/memory/embedding-client.ts` — Phase 4 territory; this plan only READS `embedding_blob` via private decode helper in `memory-store.ts`.
- `src/memory/auto-extract-runner.ts` — Phase 6 territory; `memory_source='delta-contradiction'` propagation lives there.
