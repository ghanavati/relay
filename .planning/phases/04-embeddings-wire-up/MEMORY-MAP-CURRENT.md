# MEMORY-MAP-CURRENT.md — Phase 4 baseline

**Scope:** `src/memory/` snapshot for Phase 4 (embeddings wire-up). File:line citations only. No code changes.

---

## 1. File inventory — `src/memory/`

**Source (16):**
- `auto-extract-berry.ts`, `auto-extract-consent.ts`, `auto-extract-runner.ts`, `auto-extract-schema.ts`, `auto-extract-transcript.ts`
- `consolidation.ts`
- `corpus-store.ts`
- `db-migrations.ts`
- `embedding-client.ts` ← Phase 4 wraps this
- `memory-engine.ts` ← Phase 4 extends (purity-preserving)
- `memory-store.ts` (1481 lines, oversized — over 800-line ceiling)
- `types.ts`

**Tests (26):** `auto-extract-{berry,consent,runner,schema,transcript}.test.ts`, `budgeted-recall.test.ts`, `consolidation.test.ts`, `corpus-{query,store}.test.ts`, `embedding-client.test.ts` (24 cases), `embeddings-migration.test.ts` (10 cases), `estimate-tokens.test.ts`, `memory-{candidates,count,files-filter,forget,gc,get,handoff,lint-extra,lint,purge,recall-tracking,remember,search,touch,trust-tier,upsert,wipe}.test.ts`, `score-memory.test.ts`

**Fixtures:** `__fixtures__/_generate-v0.1.2.mjs` (line 297 references "row with no embedding_blob")

---

## 2. `embedding-client.ts` — full API surface

**Exports (`embedding-client.ts:20,41-50,52-60,62-69,88-129,240-245,252-257`):**
- `EXPECTED_EMBEDDING_DIM = 768` (`:20`) — 3072 bytes BLOB
- `type EmbeddingReason` (`:41-50`): `'empty-input' | 'unreachable' | 'timeout' | 'http-500' | 'http-4xx' | 'parse-error' | 'wrong-dim' | 'not-loaded' | 'no-data'`
- `interface EmbeddingResult` (`:52-60`): `{ readonly ok: boolean; vector?: Float32Array; reason?: EmbeddingReason; got?: number; note?: string }`
- `interface EmbedOptions` (`:62-69`): `{ endpoint: string; model: string; timeoutMs?: number; fetchImpl?: typeof fetch }`
- `async probeEmbeddingsModel(opts: EmbedOptions): Promise<EmbeddingResult>` (`:88-129`) — GET `/v1/models`, asserts `opts.model` in `data[].id`
- `async embedDocument(text, opts): Promise<EmbeddingResult>` (`:240-245`) — prefix `'search_document: '` (`:26`)
- `async embedQuery(text, opts): Promise<EmbeddingResult>` (`:252-257`) — prefix `'search_query: '` (`:29`)

**Internals:** `embedWithPrefix` (`:152-232`) — AbortController timeout (default 5_000 ms `:23`), POST `/v1/embeddings` (`:164`), body has NO temperature/top_p/stream (`:174-177`); empty-input short-circuit (`:160-162`); dim refusal (`:222-224`).

**Module-load guard (`:32-39`):** asserts little-endian host; throws at import time on big-endian.

**No throw contract:** every failure → `{ ok: false, reason }`.

---

## 3. `db-migrations.ts` — embedding column state

**Shipped (`db-migrations.ts:94-100`):**
```
if (!existingCols.has('embedding_blob')) {
  db.prepare('ALTER TABLE memories ADD COLUMN embedding_blob BLOB').run();
}
```
Nullable, no DEFAULT, no index. Comment confirms "PLAN-4 §5 — semantic embeddings".

**NOT YET SHIPPED:** `embedding_model` column — Phase 4 T1 will add it after line `:100` per PLAN (`PLAN.md:135,162-163,415`).

**Migration pattern (`:60-104`):** PRE_ALTER_DDL (`:15-37`) → PRAGMA `table_info` ALTERs (`:65-100`) → POST_ALTER_DDL indexes + FTS5 (`:39-57,103-105`).

**Tests (`embeddings-migration.test.ts:35-170`):** verify BLOB column exists (`:36-58`), idempotent (`:61-75`), insert NULL roundtrip (`:77-116`), insert 3072-byte buffer roundtrip (`:118-170`).

---

## 4. `memory-store.ts` — `remember()` body + INSERT

**Signature (`memory-store.ts:273-286`):** sync `remember(params): string`. Better-sqlite3 — `this.db.prepare(...).run(...)` (`:315-344`) is synchronous.

**Body trace:**
- `:287-288` — rate-limit + workdir guards
- `:289-293` — `randomUUID()`, `Date.now()`, sanitize, estimate, merge tags
- `:295-302` — SHIP-58 60s content_hash dedup (early return)
- `:310-314` — `computeTrustLevel` for `initialTrustLevel`
- `:315-344` — single `INSERT` (19 columns) — **no `embedding_blob` column listed**
- `:346` — `this.gcByTokenBudget()`
- `:347` — `return memoryId`

**Microtask hook target (per PLAN `:187`):** after line `:344` INSERT, before `:346` GC — `queueMicrotask(() => embedDocument(content, { endpoint, model }).then(r => updateEmbedding(...)).catch(() => {}))`. Mirror in `upsert()` after `:439`.

**`upsert()` INSERT (`memory-store.ts:411-439`):** parallel structure; same 19 columns; trust_level stamped at `:406-410`.

**`rowToMemory` (`:78-104`):** 17 fields mapped — Phase 4 T1 must add `embedding_model` parse here; embedding fields stay OFF the `Memory` interface (engine purity).

**`getCandidates` (`:585-609`):** FTS5 path (`:588-601`) → fallback recency path (`:604-608`). Must stay sync.

---

## 5. `memory-engine.ts` — purity baseline

**Imports (`memory-engine.ts:8-9`):**
```
import type { Memory, MemoryType, ScoredMemory, RecallQuery, RecallResult } from './types.js';
import { TYPE_WEIGHTS, DECAY_HALF_LIFE_DAYS } from './types.js';
```
**Only `./types.js`** — no DB, no fetch, no `embedding-client`. Phase 4 must preserve.

**Exports:**
- `estimateTokens(text): number` (`:18-20`) — char/4 heuristic
- `interface ScoreComponents` (`:81-89`): `{ tag, content, recency, type, pin, trust, success }` — each weighted contribution
- `interface ScoreBreakdown` (`:91-94`): `{ total, components }`
- `scoreMemoryDetailed(memory, query, now): ScoreBreakdown` (`:115-161`) — canonical impl. `contentScore = computeContentScore(memory.content, query.query)` at `:117`. With-query weights: tag×0.35 + content×0.15 + recency×0.25 + type×0.15 + pin×0.10 + trust + success. No-query: recency×0.45 + type×0.35 + pin×0.20.
- `scoreMemory(memory, query, now): number` (`:179-181`) — thin wrapper `→ .total`
- `budgetedRecall(memories, query, now): RecallResult` (`:195-230`) — sync, no opts. Maps `m → score` (`:196-199`), sorts (`:202`), filters `< MIN_RELEVANCE_SCORE = 0.15` (`:204,208`), greedy packs (`:215-222`).

**Phase 4 signature change (PLAN `:138`):** add optional `opts?: ScoreOptions` + `similarities?: Map<id, sim>`. Backward compat — `scoreMemory(m, q, now)` no-opts must remain byte-identical.

---

## 6. `types.ts` — interfaces

**`MemoryRow` (`types.ts:31-54`):** 18 readonly fields. **Confirmed `embedding_blob: Buffer | null` present** at `:53` with PLAN-4 §5 comment. **`embedding_model` field NOT present** — Phase 4 T1 must add `readonly embedding_model: string | null;` mirroring `:53`.

**`Memory` (`:56-76`):** 17 fields, no embedding fields — engine purity barrier. Must stay this way (PLAN `:114,167`).

**`ScoredMemory extends Memory` (`:78-80`):** adds `score: number`.

**`RecallQuery` (`:89-100`):** 9 optional + `token_budget` required. No embedding-related field needed (similarities computed externally per PLAN `:139`).

**Type constants (`:8`, `:11`, `:19`, `:103-122`):** `MemoryType` union, `MemorySource`, `TrustLevel`, `TYPE_WEIGHTS`, `DECAY_HALF_LIFE_DAYS`.

---

## 7. `consolidation.ts` — embedding-dedup relevance

**Two consolidation systems coexist:**

**A. `consolidation.ts` (91 lines) — tag-based clustering** (cited functions):
- `findConsolidationClusters(memories, minSharedTags=2)` (`:24-53`) — pure tag-overlap clustering
- `applyConsolidation(store, clusters)` (`:59-89`) — calls `store.upsert` + `store.forget`
- **No content-similarity** — purely tag-based. Embeddings would NOT directly replace this.

**B. `memory-store.ts:1146-1296` (`consolidate()`)** — content-based dedup, the real cosine candidate:
- 3-stage: exact dup (`:1184-1210`) → near-dup via Jaccard (`:1212-1235`) → chronological (`:1237-1274`)
- Helpers: `tokenize` (`:173-175`), `jaccard` (`:178-184`), `clusterByJaccard` (`:191-236`)
- Default threshold 0.85 (`:1152`)
- **Phase 4 does NOT touch this** (PLAN only modifies scoring path). Future phase could replace Jaccard with cosine over `embedding_blob`.

**Content-hash dedup (`memory-store.ts:295-302`)** — first-500-char sha256 60s window. Independent of embeddings.

---

## 8. Callers of `budgetedRecall` outside `src/memory/`

| File | Line | Call site |
|---|---|---|
| `src/tools/memory_search.ts` | `:38` | `budgetedRecall(candidates, query, Date.now())` — sync call inside currently-sync `handleMemorySearch` (PLAN T6 converts to async) |
| `src/tools/recall.ts` | `:28` | `budgetedRecall(candidates, query, Date.now())` |
| `src/context/layers.ts` | `:231` | `budgetedRecall(candidates, query, Date.now())` |
| `src/cli/cmd-tui.ts` | `:87,89` | typed via `Parameters<typeof budgetedRecall>[1]` — signature change ripples here |

**Backward-compat requirement:** all 4 call sites pass `(memories, query, now)` — Phase 4 must keep this 3-arg form valid. New optional 4th arg (`opts?` with `similarities?`) per PLAN `:138`.

**Internal call:** `memory-engine.ts:198` (`budgetedRecall` → `scoreMemory`) — no change to internal contract.

**Also threading `scoreMemoryDetailed`:** `src/cli/cmd-memory-why.ts:12,114` (single caller — `relay memory why`).

---

## 9. Env var conventions (reference for Phase 4)

- `RELAY_AUTO_EXTRACT_ENDPOINT` / `RELAY_AUTO_EXTRACT_MODEL` — used by `auto-extract-runner.ts` (test refs at `cmd-memory-auto-extract.test.ts:218-329`).
- PLAN `:187` introduces `LMSTUDIO_ENDPOINT` (default `http://127.0.0.1:1234`) + `RELAY_EMBEDDING_MODEL` (feature flag — unset = no embed call).
- No `embedding-client` import outside its own file/tests yet. PLAN `:139` introduces new `src/memory/semantic-similarities.ts` as the impure boundary.

---

## 10. Phase 4 wiring deltas (for reference, not action)

| Surface | Current | Phase 4 target |
|---|---|---|
| `embedding_blob` col | shipped (`db-migrations.ts:98-100`) | unchanged |
| `embedding_model` col | absent | T1 ALTER after `:100` |
| `MemoryRow` | 18 fields | +1 (`embedding_model`) |
| `Memory` | 17 fields, no embedding | unchanged (purity) |
| `remember()` INSERT | sync, no embed | sync + queueMicrotask after `:344` |
| `upsert()` INSERT | sync, no embed | sync + queueMicrotask after `:439` |
| `memory-engine.ts` imports | `./types` only | unchanged (purity) |
| `scoreMemoryDetailed` signature | `(memory, query, now)` | `(memory, query, now, opts?)` |
| `budgetedRecall` signature | `(memories, query, now)` | `(memories, query, now, opts?)` — 4 external callers must compile unchanged |
| `tools/memory_search.ts` | sync `handleMemorySearch` | T6 → async |
| Cosine helper | n/a | NEW `semantic-similarities.ts` (impure) |

---

*Baseline snapshot — 2026-05-20. Engine purity & sync I/O are load-bearing invariants. Do not edit `Memory` interface; do not add `await` to `getCandidates`/`remember`.*
