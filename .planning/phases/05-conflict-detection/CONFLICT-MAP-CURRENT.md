# Conflict Detection — Current Memory Subsystem Map

**Date:** 2026-05-20
**Scope:** read-only map of insertion points and existing primitives Phase 5 will touch.
**Files inspected:** memory-store.ts (1480 LOC), memory-engine.ts (230 LOC), db-migrations.ts (120 LOC), types.ts (123 LOC), consolidation.ts (90 LOC), context/layers.ts (546 LOC), 4 budgetedRecall caller sites.

---

## 1. memory-store.ts — write paths and Jaccard helpers

### `remember()` — `src/memory/memory-store.ts:273-348`
- Sync better-sqlite3. Single bare `INSERT` at `:316-344`; **no transaction wrapper.**
- 60s content-hash dedup pre-check at `:299-302` (short-circuits to existing id).
- Computes `initialTrustLevel` inline at `:310-314` before INSERT — Phase 5 must follow this pattern for any conflict-related column writes inside the same row.
- Calls `gcByTokenBudget()` at `:346` after INSERT — runs OUTSIDE any transaction.

### `upsert()` — `src/memory/memory-store.ts:360-455`
- **WRAPPED in `this.db.transaction(...)` at `:379-442`**, named `upsertTx`. Returns the new id from the closure.
- Inside tx: supersedes existing entries at `:381-394`, then INSERT at `:411-439`.
- Auto-purge of old superseded rows at `:447-453` runs OUTSIDE the transaction (try/catch wrapped).
- **Implication for Phase 5:** if conflict detection mutates two rows reciprocally (write B → update A's `conflicts_with_json`), the work belongs INSIDE a `db.transaction()` to keep the pair atomic. `remember()` would need a new tx wrapper; `upsert()` can extend the existing one.

### `jaccard()` helper — `src/memory/memory-store.ts:178-184`
- **Plan-checker warning was incorrect** — the helper is at line 178, not 217 or 1260.
- Signature: `function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number`
- File-scope private (not exported); handles empty/empty as 0 to avoid NaN.
- Line 217 inside `clusterByJaccard` and line 1260 inside `consolidate()` are *call sites* of this helper, not duplicate definitions. One canonical source.

### `clusterByJaccard()` — `src/memory/memory-store.ts:191-236`
- File-scope private function. Single-linkage transitive clustering via union-find.
- Caches per-pair similarity in a `simKey()`-keyed Map at `:208-209`, exposes via `similarityTo(idA, idB)` accessor on each returned cluster (`:233`).
- Currently used only by `consolidate()` step 2 at `:1217`. Phase 5 may reuse it OR (more likely) write a simpler pairwise comparator since conflict detection is N×N within one workdir slice and needs reciprocal pair links, not transitive clusters.

### `tokenize()` — `src/memory/memory-store.ts:173-175`
- Reusable: lowercase, `\W_` split, ≥3 chars. Matches plan's `contentJaccard` helper requirement.

### `normalizeContent()` — `src/memory/memory-store.ts:168-170`
- Exact-dup normalization. Not used by conflict path but documents the existing similarity vocabulary.

---

## 2. memory-engine.ts — recall pipeline insertion point

### `budgetedRecall()` — `src/memory/memory-engine.ts:195-230`
- Pure function; no DB access.
- Score → sort DESC → filter by `MIN_RELEVANCE_SCORE = 0.15` (`:204, :208`) → greedy pack within `token_budget` (`:215-222`).
- Returns `RecallResult` with `memories`, `total_tokens`, `budget_remaining`, `omitted_count`.
- **Phase 5 pairwise-pass insertion point:** after sort at `:202` and before filter at `:208`. Walk the scored array; for each `i,j` pair where `jaccard(tags_i, tags_j) >= tagThreshold && jaccard(tokens_i, tokens_j) >= contentJaccardThreshold && type_i === type_j && workdir_i === workdir_j`, record reciprocal conflict ids. Then run the existing pack/filter loop.
- The function currently takes `(memories, query, now)`. To keep callers stable, additions should be opt-in via either a new optional 4th arg or a new query field (cf. how `min_trust` was added to `RecallQuery` at `types.ts:99`).
- **No conflict-related state exists today** — `ScoredMemory` (`types.ts:78-80`) is just `Memory & { score }`. Phase 5 needs to surface `conflicts_with: readonly string[]` somewhere (either on `ScoredMemory` or as a sibling map in `RecallResult`).

---

## 3. db-migrations.ts — PRAGMA ALTER pattern

### Migration file: `src/memory/db-migrations.ts:1-120`
- Three-phase pattern: `PRE_ALTER_DDL` (`:15-37`) → PRAGMA-guarded `ALTER ADD COLUMN` block (`:65-100`) → `POST_ALTER_DDL` (`:39-57`).
- Existing ALTER pattern (copy for `conflicts_with_json`):
  - Read columns once at `:66-68`: `existingCols = new Set(... PRAGMA table_info(memories) ...)`.
  - Each conditional ALTER follows shape `if (!existingCols.has('<col>')) { db.prepare("ALTER TABLE memories ADD COLUMN <col> <type> [DEFAULT <v>]").run(); }` — see `:72-74` (`sources_json`), `:82-84` (`memory_source`), `:91-93` (`files_json`), `:98-100` (`embedding_blob`).
  - `:91-93` `files_json` is the closest precedent: `TEXT NOT NULL DEFAULT '[]'` — identical type/default to what Phase 5 needs.
- **CONFIRMED: `conflicts_with_json` does NOT exist yet.** `grep -n 'conflicts_with' src/memory/{db-migrations,types,memory-store}.ts` returned zero matches. Phase 5 is green-field for this column.
- Insert the new check anywhere between `:69` and `:100` — order does not matter since all checks are guarded against `existingCols`. Convention is "newest column last"; placing it after the `embedding_blob` block at `:101` is consistent.
- `MemoryRow` interface at `types.ts:31-54` must also gain `conflicts_with_json: string` (mirror of `sources_json: string` at `:46`).

---

## 4. context/layers.ts — annotation insertion point

### `loadRecalledLessonsContent()` — `src/context/layers.ts:199-261`
- Dynamic-imports `MemoryStore` + `budgetedRecall` at `:217-218`, calls `getCandidates` at `:229`, `budgetedRecall` at `:231`.
- Sort step at `:244-250` reorders failure-first.
- **Annotation line builder at `:252-259`** is where `⚠ CONFLICTS WITH #N` belongs.
  - Current code at `:252-259`:
    ```
    const lines = sorted.map((memory, index) => {
      const prefix = memory.trust_level === 'unverified' ? '[UNVERIFIED] '
                   : memory.tags.includes('failure')     ? '⚠ FAILED: '
                   : '';
      return `${index + 1}. ${prefix}${guardMemoryContent(memory.content)}`;
    });
    ```
  - Phase 5 needs to compute, for each `memory`, the set of OTHER selected indices it conflicts with. Two-pass: pass 1 build `idToIndex = new Map(sorted.map((m,i) => [m.memory_id, i+1]))`, pass 2 append `⚠ CONFLICTS WITH #${indices.join(', #')}` per memory based on its `conflicts_with` array filtered to ids present in `idToIndex`.
  - Index numbering is 1-based and uses the post-sort order (not score order, not selection order from `budgetedRecall`). Phase 5 must preserve that ordering when computing index references.
- `guardMemoryContent()` at `:191-197` only mutates content text; conflicts annotation should go BEFORE or AFTER the guarded content — plan says inline marker on the same line; preserve trailing-content shape so the existing tests do not break.

### Same file — `loadContextLayers()` and friends (`:365-454`)
- No conflict logic needed here. The annotation lives one level down inside `loadRecalledLessonsContent`, which is invoked via `createRecalledLessonsLayerProvider()` at `:263-275`.

---

## 5. Callers of `budgetedRecall` (current count: 4 — Phase 4 has NOT landed)

`grep -rn 'budgetedRecall' src/ --include='*.ts'` excluding tests:

| # | File | Line | Call form |
|---|------|------|-----------|
| 1 | `src/tools/recall.ts` | `:28` | `budgetedRecall(candidates, query, Date.now())` — MCP `recall` tool. Also imports at `:2`. |
| 2 | `src/tools/memory_search.ts` | `:38` | `budgetedRecall(candidates, query, Date.now())` — MCP `memory_search` tool. Also imports at `:16`. |
| 3 | `src/context/layers.ts` | `:231` | `budgetedRecall(candidates, query, Date.now())` — dynamic import at `:218`. |
| 4 | `src/cli/cmd-tui.ts` | `:89` | `budgetedRecall(candidates, query, Date.now())` — dynamic import at `:85`, used in `readRecallPreview()` at `:82-100`. |

**There is no `cmd-memory-recall.ts` in the tree.** `relay memory recall` is routed through `src/tools/recall.ts` (the MCP handler). The only related CLI files are:
- `src/cli/cmd-memory-recall-cwd-default.test.ts` — a test file, not a caller.
- `src/cli/cmd-memory-search.ts` — uses its own search logic (FTS-only), does NOT call `budgetedRecall`. Confirmed by `grep` above.

**5th caller status:** Phase 4 (Embeddings Wire-Up) is the source of a planned 5th caller via the cosine-similarity rescore path (cf. `04-embeddings-wire-up/PLAN.md:235` "T4 — `similarities` Map on `budgetedRecall`"). Per `.planning/STATE.md:30` the milestone is currently at "Phase 1 complete — ready to start Phase 2", so **Phase 4 has NOT shipped**. Phase 5 should code against the present 4 callers and accept Phase 4 will add a 5th later; the plan's degradation note at `PLAN.md:312` already covers this dependency direction.

---

## 6. types.ts — interfaces to extend

### `MemoryRow` — `src/memory/types.ts:31-54`
- Raw DB row shape. Adding `conflicts_with_json: string` here mirrors `sources_json: string` at `:46` and `files_json: string` at `:51`. Default `'[]'`.

### `Memory` — `src/memory/types.ts:56-76`
- Domain object. Add `conflicts_with: readonly string[]` mirroring `sources: readonly string[]` at `:70` and `files: readonly string[]` at `:74`.
- `rowToMemory()` at `memory-store.ts:78-104` must `JSON.parse(row.conflicts_with_json ?? '[]')` mirroring `:93` (sources) and `:97` (files).

### `ScoredMemory` — `src/memory/types.ts:78-80`
- Trivial extension `Memory & { score: number }`. `conflicts_with` flows through automatically since it is on `Memory`.

### `RecallQuery` — `src/memory/types.ts:89-100`
- Phase 5 may add an optional threshold knob here, e.g. `conflict_jaccard_threshold?: number`, following the `min_trust?: TrustLevel` precedent at `:99`. Default should live in code, not be required.

### `RecallResult` — `src/memory/types.ts:82-87`
- `memories: readonly ScoredMemory[]` already carries conflict info via the `Memory.conflicts_with` field once added. No structural change required, but plan should confirm whether reciprocal pairs are surfaced ONLY via `Memory.conflicts_with` or ALSO via a sibling `conflict_pairs` array on `RecallResult` for richer reporting in `relay memory why`.

---

## 7. consolidation.ts — relevance for Phase 5

### `findConsolidationClusters()` — `src/memory/consolidation.ts:24-53`
- **Different similarity strategy** than what Phase 5 needs: clusters by SHARED TAGS only (`a.tags.filter(t => b.tags.includes(t))` at `:36`), not by content Jaccard. Threshold is "≥2 shared tags" at `:37`.
- Pure function (Memory[] in, ConsolidationCluster[] out). Same purity contract Phase 5 should hold for its conflict detector.
- **Not a drop-in pattern for conflicts** because:
  1. It uses tag-overlap counting, not Jaccard ratio.
  2. It builds clusters (groups), not pairwise reciprocal edges.
  3. It treats clusters as merge candidates (downstream `applyConsolidation` writes); Phase 5 only annotates.
- **What IS reusable:** the loop shape at `:28-40` (i, j upper-triangle with `assigned` Set to skip already-processed rows) is the same skeleton Phase 5's pairwise pass will need, minus the "assigned" exclusion since conflict detection is many-to-many.

### `applyConsolidation()` — `src/memory/consolidation.ts:59-89`
- Demonstrates how the existing system mutates after a similarity pass: `store.upsert(...)` for the primary, `store.forget(m.memory_id)` for the rest (`:73-86`).
- **Not relevant to Phase 5 conflict path** — conflict detection writes a JSON column, it does NOT supersede or forget rows. Listed here only because the plan-checker may flag the similarity overlap; the semantic outcomes are disjoint.

---

## 8. Quick-reference: what Phase 5 will touch (file:line)

| Change | File:Line | Pattern source |
|--------|-----------|----------------|
| Add `conflicts_with_json` ALTER | `db-migrations.ts:~101` (after `embedding_blob` block at `:98-100`) | `files_json` at `:91-93` |
| Add `conflicts_with_json` to MemoryRow | `types.ts:~51` (after `files_json`) | `files_json: string` line |
| Add `conflicts_with` to Memory | `types.ts:~75` (after `files`) | `files: readonly string[]` |
| Parse in `rowToMemory` | `memory-store.ts:~97` | `JSON.parse(row.files_json ?? '[]')` at `:97` |
| Wrap `remember()` in tx | `memory-store.ts:273-348` | `upsert()` tx pattern at `:379-442` |
| Reciprocal UPDATE inside that tx | new code in wrapped `remember()` | `upsert()` supersession UPDATE at `:391-394` |
| Pairwise pass | `memory-engine.ts:~203` (between sort at `:202` and filter at `:208`) | new code; reuse `jaccard` from `memory-store.ts:178` (will need export) |
| Annotation in lessons layer | `context/layers.ts:252-259` | extend existing `prefix` branch |
| No CLI changes required | — | `relay memory recall` flows through MCP `recall.ts` |

---

## 9. Notable absences (verified by grep)

- `conflicts_with_json` column: **does not exist** in `db-migrations.ts`, `types.ts`, or `memory-store.ts`.
- `conflicts_with` field on `Memory`: **does not exist**.
- Any `cosineSimilarity` or `embedding_model` column wiring: **not yet present** (Phase 4 territory).
- Any pairwise-conflict logic in `budgetedRecall`: **not present** — only score-and-pack.
- Any conflict marker in `loadRecalledLessonsContent`: **not present** — only `[UNVERIFIED]` and `⚠ FAILED:` prefixes at `layers.ts:255-257`.

---

*End of map. No code changes were made in producing this document.*
