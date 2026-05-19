---
phase: 04-embeddings-wire-up
plan: 01
type: tdd
wave: 1
depends_on: [01-schema-cleanup, 03-agentic-lmstudio-runner]
files_modified:
  - src/memory/db-migrations.ts
  - src/memory/types.ts
  - src/memory/memory-store.ts
  - src/memory/memory-engine.ts
  - src/memory/semantic-similarities.ts        # NEW
  - src/memory/semantic-similarities.test.ts   # NEW
  - src/memory/score-memory.test.ts            # extend
  - src/memory/budgeted-recall.test.ts         # extend
  - src/memory/memory-store.test.ts            # extend (lazy embed + dedup)
  - src/cli/cmd-memory-ops.ts                  # executeRecallCommand
  - src/cli/cmd-memory-search.ts               # CLI search
  - src/tools/memory_search.ts                 # MCP search (sync → async)
  - src/tools/memory_search.test.ts            # extend
  - src/tools/recall.ts                        # MCP recall (verify; wire if applicable)
  - test/embeddings-wire-up.integration.test.ts # NEW — EMBED-05
autonomous: false
requirements: [EMBED-01, EMBED-02, EMBED-03, EMBED-04, EMBED-05]
user_setup:
  - service: lmstudio-embeddings
    why: "T7 integration test + T8 runtime validation require nomic-embed-text-v1.5 loaded; word-overlap fallback ships if absent."
    env_vars:
      - name: LMSTUDIO_ENDPOINT
        source: "Existing convention (default http://127.0.0.1:1234)"
      - name: RELAY_EMBEDDING_MODEL
        source: "Set to text-embedding-nomic-embed-text-v1.5; unset disables embedding generation"
    dashboard_config:
      - task: "Load nomic-embed-text-v1.5 in LM Studio"
        location: "lms load text-embedding-nomic-embed-text-v1.5"

must_haves:
  truths:
    - "User writes 5 CSS-naming memories, queries 'naming conventions for stylesheets', 'prefer kebab-case' recalled in top 3 despite zero word overlap (EMBED-05)"
    - "`relay memory remember` returns sync; ~1s later `relay memory get <id>` shows embedding_blob populated (EMBED-01)"
    - "LM Studio offline → recall still works (word-overlap fallback); embedding_blob NULL; stderr warning surfaces; no throws"
    - "`relay memory why <id>` shows ScoreComponents.content reflecting cosine when present (EMBED-04)"
    - "memory-engine.ts imports only ./types + ./constants; no fetch/IO/DB inside scoring"
  artifacts:
    - path: "src/memory/db-migrations.ts"
      provides: "embedding_model TEXT column via PRAGMA-guarded ALTER"
      contains: "embedding_model"
    - path: "src/memory/semantic-similarities.ts"
      provides: "computeSemanticSimilarities(store, query, candidates, opts) impure helper"
      exports: ["computeSemanticSimilarities", "cosineSimNormalized", "blobToFloat32"]
    - path: "src/memory/memory-engine.ts"
      provides: "ScoreOptions + opts.semanticSimilarity threaded through scoreMemoryDetailed/scoreMemory/budgetedRecall"
      contains: "ScoreOptions"
    - path: "src/memory/memory-store.ts"
      provides: "remember/upsert schedule queueMicrotask after sync INSERT; embedding_model written alongside blob"
      contains: "queueMicrotask"
    - path: "test/embeddings-wire-up.integration.test.ts"
      provides: "EMBED-05 zero-word-overlap recall integration"
      contains: "naming conventions for stylesheets"
  key_links:
    - from: "src/memory/memory-store.ts::remember"
      to: "src/memory/embedding-client.ts::embedDocument"
      via: "queueMicrotask after sync INSERT — unawaited; swallows errors; stderr-loud on failure"
      pattern: "queueMicrotask\\(.*embedDocument"
    - from: "src/cli/cmd-memory-ops.ts::executeRecallCommand"
      to: "src/memory/semantic-similarities.ts::computeSemanticSimilarities"
      via: "await before passing into budgetedRecall as fourth arg"
      pattern: "await computeSemanticSimilarities"
    - from: "src/tools/memory_search.ts::handleMemorySearch"
      to: "src/memory/semantic-similarities.ts::computeSemanticSimilarities"
      via: "function becomes async; called before budgetedRecall"
      pattern: "await computeSemanticSimilarities"
    - from: "src/memory/memory-engine.ts:117"
      to: "opts.semanticSimilarity"
      via: "replaces computeContentScore call when defined"
      pattern: "opts\\?\\.semanticSimilarity"
---

<objective>
Wire the shipped `src/memory/embedding-client.ts` (commit `a2b3a54`) into the recall pipeline so cosine similarity from `nomic-embed-text-v1.5` drives `ScoreComponents.content` for memories whose `embedding_blob` (commit `e3f3a9a`) is populated. Word-overlap remains the fallback for un-backfilled rows and offline-LM-Studio scenarios.

Purpose: Phase 5 (Conflict Detection) calibrates its false-positive gate against cosine (CONFLICT-04). Phase 6 (Delta Extraction) ranks candidates with the same metric. Both depend on this phase per `research/SUMMARY.md:98-118`.

Output: PRAGMA-guarded `embedding_model` column, additive engine signature change, new `computeSemanticSimilarities()` at the impure caller layer, async wire-up at `cmd-memory-ops.ts::executeRecallCommand` + `tools/memory_search.ts::handleMemorySearch`, one CSS-naming integration test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/research/SUMMARY.md
@.planning/research/PITFALLS.md
@.planning/v0.2-improvised-scrap/EMBEDDING-PATTERN.md
@.planning/v0.2-improvised-scrap/NOMIC-EMBED-SPECS.md
@.planning/v0.2-improvised-scrap/MEMORY-MAP.md
@src/memory/embedding-client.ts
@src/memory/embedding-client.test.ts
@src/memory/memory-engine.ts
@src/memory/memory-store.ts
@src/memory/db-migrations.ts
@src/memory/types.ts
@src/tools/memory_search.ts
@src/cli/cmd-memory-ops.ts

<interfaces>
Key contracts the executor needs (full bodies in @-referenced files):

- **`embedding-client.ts` (SHIPPED)**: `embedDocument(text, opts) → Promise<EmbeddingResult>` prefixes `search_document: `; `embedQuery(text, opts) → Promise<EmbeddingResult>` prefixes `search_query: `. Never throws. `EmbeddingResult = { ok, vector?: Float32Array(768), reason?, got?, note? }`. `EXPECTED_EMBEDDING_DIM = 768` (3072 bytes/BLOB).
- **`memory-engine.ts:115,179,195` (CURRENT)**: `scoreMemoryDetailed(memory, query, now)`, `scoreMemory(memory, query, now)`, `budgetedRecall(memories, query, now)` — all sync, no opts. Line `117` does `const contentScore = computeContentScore(memory.content, query.query)`.
- **`types.ts:31,53,56`**: `MemoryRow.embedding_blob: Buffer | null` shipped. `Memory` interface has NO embedding field (engine purity — never reads blob).
- **`db-migrations.ts:94-100`**: `embedding_blob BLOB` ALTER shipped. **NO `embedding_model` column yet — T1 adds it.**
- **`cli.ts:314,561,706`**: `executeRecallCommand`, `executeMemorySearchCommand`, `dispatchMemory` ALL already `await import` and `await` the handler — no public surface change.
- **`tools/memory_search.ts:22`**: `handleMemorySearch(args): McpToolResult` **currently sync**. T6 converts to `async`.
- **`memory-store.ts:585`**: `getCandidates(query): Memory[]` — sync (better-sqlite3). **MUST stay sync** through this phase.
</interfaces>
</context>

## Goal

Make cosine similarity the `content` signal in `scoreMemoryDetailed()` when `embedding_blob` is populated AND model matches, while preserving:

1. **Engine purity** — `memory-engine.ts` imports only `./types` + `./constants` (PITFALL 2.1; CI lint enforced).
2. **Sync `remember()` + sync `getCandidates()`** — better-sqlite3 is sync; cascading async re-writes ~28 callers (`MEMORY-MAP.md §7`).
3. **Backward compat** — `scoreMemory(m, q, now)` without opts → byte-identical numeric result. `embedding_blob IS NULL` → word-overlap. LM Studio offline → word-overlap + stderr-loud warning (PITFALL 2.4).
4. **Cross-model rejection** — `embedding_model` column stored alongside blob; future model swap cannot silently corrupt cosine (PITFALL 2.3).

## Files to touch (line ranges)

| File | Lines | Change |
|---|---|---|
| `src/memory/db-migrations.ts` | insert after `:100` | PRAGMA ALTER `embedding_model TEXT` |
| `src/memory/types.ts` | `:31-54` (MemoryRow) | Add `embedding_model: string \| null` (Memory unchanged) |
| `src/memory/memory-store.ts` | `:78-104` (rowToMemory); `:296-344` (remember); `:397-439` (upsert) | Parse new col; queueMicrotask after INSERT; UPDATE writes blob + model |
| `src/memory/memory-engine.ts` | `:115-181`; `:195-228` | Add `ScoreOptions`; thread `opts?` + `similarities?` |
| `src/memory/semantic-similarities.ts` | NEW | Impure helper: embed query → parse blobs → Map<id, sim> |
| `src/memory/semantic-similarities.test.ts` | NEW | Unit tests with mock fetch |
| `src/memory/score-memory.test.ts` | extend | opts.semanticSimilarity branch |
| `src/memory/budgeted-recall.test.ts` | extend | similarities map (empty / partial / full) |
| `src/memory/memory-store.test.ts` | extend | Lazy embed UPDATE; queueMicrotask flush; dedup unchanged |
| `src/cli/cmd-memory-ops.ts` | `executeRecallCommand` body | `await computeSemanticSimilarities` before `budgetedRecall` |
| `src/cli/cmd-memory-search.ts` | search body | Same pattern |
| `src/tools/memory_search.ts` | `:22-65` | Convert sync → async; await helper |
| `src/tools/memory_search.test.ts` | extend | Async signature + similarity threading |
| `src/tools/recall.ts` | recall body | Same pattern (verify exists in T6) |
| `test/embeddings-wire-up.integration.test.ts` | NEW | EMBED-05 CSS-naming integration |

## Task breakdown (TDD strict)

### T1 — Migration: add `embedding_model` column

<task type="tdd" tdd="true">
  <name>T1: PRAGMA-guarded migration for embedding_model</name>
  <files>src/memory/db-migrations.ts, src/memory/memory-store.test.ts, src/memory/types.ts</files>
  <behavior>
    - RED: Open in-memory DB without `embedding_model`, run `migrateMemoryTables`, assert PRAGMA shows new TEXT column (nullable, no DEFAULT)
    - RED: Run migration twice — second pass no-op (idempotency)
    - RED: Existing memory-store tests still green after MemoryRow extension
    - GREEN: After `embedding_blob` block (`db-migrations.ts:98-100`) add `if (!existingCols.has('embedding_model')) { db.prepare('ALTER TABLE memories ADD COLUMN embedding_model TEXT').run(); }`
    - GREEN: Extend `MemoryRow` in `types.ts:31` with `readonly embedding_model: string | null;` (mirrors `embedding_blob: Buffer | null` at `:53`)
    - GREEN: Update `rowToMemory` (`memory-store.ts:78`) to consume the column (private to MemoryStore — do NOT add to public `Memory` interface)
  </behavior>
  <action>
    Nullable, no DEFAULT. NULL = "not yet embedded" (matches `embedding_blob IS NULL`). Keeping `embedding_model` off the public `Memory` interface prevents engine-side leakage (the helper reads via MemoryStore method added in T5).
  </action>
  <verify>
    <automated>npx vitest run src/memory/db-migrations.test.ts src/memory/memory-store.test.ts</automated>
  </verify>
  <done>PRAGMA shows `embedding_model TEXT` nullable; migration idempotent; `MemoryRow.embedding_model` exists; `Memory` interface unchanged.</done>
</task>

### T2 — Lazy embed-on-write via `queueMicrotask`

<task type="tdd" tdd="true">
  <name>T2: queueMicrotask after sync INSERT in remember + upsert</name>
  <files>src/memory/memory-store.ts, src/memory/memory-store.test.ts</files>
  <behavior>
    - RED: `store.remember({ content: 'X' })` returns string sync; row's `embedding_blob` initially NULL
    - RED: With mocked embedClient returning Float32Array(768 zeros), after `await new Promise(r => queueMicrotask(r))`, row has `length(embedding_blob) === 3072` AND `embedding_model === 'text-embedding-nomic-embed-text-v1.5'`
    - RED: With mock `{ ok: false, reason: 'unreachable' }`, row stays NULL, no throw, exactly one stderr line matching `RELAY: embedding skipped` (per-process dedup)
    - RED: With `RELAY_EMBEDDING_MODEL` unset, NO embed call, NO warning, row NULL (feature off)
    - RED: Existing 60s `content_hash` dedup (`memory-store.ts:296-302`) test still green
    - RED: `upsert()` follows same lazy path
    - GREEN: Inside `remember()` after the INSERT (`memory-store.ts:344` area): `const endpoint = process.env.LMSTUDIO_ENDPOINT ?? 'http://127.0.0.1:1234'; const model = process.env.RELAY_EMBEDDING_MODEL; if (model) { queueMicrotask(() => { embedDocument(content, { endpoint, model }).then(r => { if (r.ok && r.vector) this.updateEmbedding(memoryId, Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength), model); else this.warnEmbedSkipped(r.reason); }).catch(() => {}); }); }` — NEVER await; never throw.
    - GREEN: Mirror at `upsert()` (`memory-store.ts:430` area)
    - GREEN: Private `updateEmbedding(id, blob, model)`: `UPDATE memories SET embedding_blob = ?, embedding_model = ? WHERE memory_id = ?`
    - GREEN: Private `warnEmbedSkipped(reason)`: per-process Set dedup; format `RELAY: embedding skipped (LM Studio /v1/embeddings ${reason}). Recall falling back to word-overlap. Run 'relay doctor' to check.`
    - GREEN: Inject `embedClient?: typeof embedDocument` constructor option for testability (mirrors existing `db?: Database` injection)
  </behavior>
  <action>
    Use `queueMicrotask` (NOT `setImmediate`). Tests flush with single Promise tick. `setImmediate` is non-deterministic in vitest's event loop.

    `Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)` produces a 3072-byte view (little-endian; embedding-client asserts LE host at module load `:31-39`).

    Track `warnedReasons = new Set<string>()` at module/instance scope — one stderr line per (process, reason).
  </action>
  <verify>
    <automated>npx vitest run src/memory/memory-store.test.ts</automated>
  </verify>
  <done>remember()/upsert() return sync; one microtask later blob+model populated on success; stderr-loud once per failure reason; `RELAY_EMBEDDING_MODEL` unset → feature off; dedup unchanged.</done>
</task>

### T3 — `ScoreOptions` on `scoreMemoryDetailed` / `scoreMemory`

<task type="tdd" tdd="true">
  <name>T3: scoreMemoryDetailed/scoreMemory accept opts.semanticSimilarity</name>
  <files>src/memory/memory-engine.ts, src/memory/score-memory.test.ts</files>
  <behavior>
    - RED: `scoreMemory(memory, query, now)` (no opts) — byte-identical to pre-change result (regression)
    - RED: `scoreMemory(memory, query, now, { semanticSimilarity: 0.9 })` — contentScore = 0.9; total reflects `0.9 × 0.15` weight at `:150`
    - RED: `scoreMemory(memory, query, now, { semanticSimilarity: 0 })` — contentScore = 0 (NOT undefined-fallback); beats word-overlap-match memory at 0.5 only when summed with other signals proves the path
    - RED: `scoreMemory(memory, query, now, { semanticSimilarity: undefined })` — falls through to `computeContentScore`
    - RED: No-query branch (`memory-engine.ts:134-143`) — even with `opts.semanticSimilarity` provided, content forced to 0 (semantic similarity meaningless without query; preserve existing behavior)
    - RED: `ScoreComponents.content` field carries semantic value when used (EMBED-04 surface for `relay memory why`)
    - GREEN: Add `export interface ScoreOptions { readonly semanticSimilarity?: number }`
    - GREEN: Signature change at `:115`: `scoreMemoryDetailed(memory, query, now, opts?: ScoreOptions): ScoreBreakdown`
    - GREEN: Line `117` becomes `const contentScore = opts?.semanticSimilarity !== undefined ? Math.max(0, Math.min(1, opts.semanticSimilarity)) : computeContentScore(memory.content, query.query);`
    - GREEN: `scoreMemory` wrapper (`:179-181`) forwards opts
    - GREEN: NO new imports — `ScoreOptions` defined in-file; depends only on `./types` + `./constants`
  </behavior>
  <action>
    Defensive clamp to `[0, 1]` inside engine — embedding-client returns normalized vectors and cosine ∈ [-1, 1], but clamping protects against bad callers and matches `EMBEDDING-PATTERN.md §7`.

    No-query branch (`memory-engine.ts:134-143`) intentionally forces content=0 — preserve. Semantic similarity is only meaningful with a query.
  </action>
  <verify>
    <automated>npx vitest run src/memory/score-memory.test.ts</automated>
  </verify>
  <done>Engine imports still only `./types` + `./constants` (grep); `scoreMemory(m,q,now)` byte-identical to pre-change; opts.semanticSimilarity path used when defined; no-query branch unaffected; ScoreComponents.content carries cosine.</done>
</task>

### T4 — `similarities` Map on `budgetedRecall`

<task type="tdd" tdd="true">
  <name>T4: budgetedRecall threads ReadonlyMap<id,sim> into scorer</name>
  <files>src/memory/memory-engine.ts, src/memory/budgeted-recall.test.ts</files>
  <behavior>
    - RED: `budgetedRecall(memories, query, now)` (no map) — byte-identical to pre-change (regression)
    - RED: `budgetedRecall(memories, query, now, new Map())` — identical to no-map (both flow to word-overlap)
    - RED: Partial map (half rows have entries) — mapped rows use sim, unmapped use word-overlap
    - RED: Ordering — memory with `sim=0.9` AND zero word overlap OUTRANKS memory with `sim=undefined` AND partial word overlap (THE feature)
    - RED: `MIN_RELEVANCE_SCORE=0.15` (`:204`) still applies — `sim=0.05` AND no other signals → dropped
    - GREEN: Signature at `:195`: `budgetedRecall(memories, query, now, similarities?: ReadonlyMap<string, number>): RecallResult`
    - GREEN: Lookup at `:198`: `const sim = similarities?.get(m.memory_id); scoreMemory(m, query, now, sim !== undefined ? { semanticSimilarity: sim } : undefined)`
    - GREEN: No other changes — sort/threshold/pack-loop unchanged
  </behavior>
  <action>
    `ReadonlyMap` (not `Map`) — engine never mutates. Empty-map MUST behave identically to no-map — guards against callers passing `new Map()` "to be safe" and accidentally suppressing semantics.
  </action>
  <verify>
    <automated>npx vitest run src/memory/budgeted-recall.test.ts</automated>
  </verify>
  <done>No new imports; all pre-existing tests green; new tests cover no-map / empty / partial / full / ordering-flip.</done>
</task>

### T5 — `computeSemanticSimilarities()` at impure boundary

<task type="tdd" tdd="true">
  <name>T5: computeSemanticSimilarities helper (impure boundary)</name>
  <files>src/memory/semantic-similarities.ts (NEW), src/memory/semantic-similarities.test.ts (NEW), src/memory/memory-store.ts (add getRawEmbeddings)</files>
  <behavior>
    - RED: With mock fetch returning valid 768-dim, returns Map sized to count of candidates having non-null blob AND matching model
    - RED: `query.query` empty (tags-only recall) → empty Map, ZERO embed calls
    - RED: `RELAY_EMBEDDING_MODEL` unset → empty Map, ZERO embed calls, ZERO warnings
    - RED: Mock failure (`unreachable`/`timeout`/`http-500`) → empty Map, one stderr warning, deduped per reason
    - RED: Mock `wrong-dim` → empty Map, warning (defense-in-depth — embedding-client also rejects)
    - RED: Cross-model rejection — candidate row with `embedding_model='bge-large-en-v1.5'` while query embedded with `nomic-embed-text-v1.5` → row's ID NOT in result Map
    - RED: Mixed corpus — 3 candidates valid + 2 NULL blob → Map has exactly 3 entries
    - RED: Cosine fixtures (`EMBEDDING-PATTERN.md §7`): `cosineSimNormalized([1,0,0],[1,0,0]) === 1.0`; `=== 0.0` for orthogonal; `=== -1.0` for anti-parallel raw
    - RED: BLOB → Float32Array round-trip via `blobToFloat32(Buffer.from(new Float32Array([0.1,-0.2,0.3]).buffer))`
    - GREEN: New file exports:
      - `blobToFloat32(blob: Buffer): Float32Array` — view without copy when aligned
      - `cosineSimNormalized(a: Float32Array, b: Float32Array): number` — raw `[-1, 1]`
      - `async computeSemanticSimilarities(store: MemoryStore, query: RecallQuery, candidates: readonly Memory[], opts?: { fetchImpl?; endpoint?; model?; timeoutMs? }): Promise<ReadonlyMap<string, number>>`
    - GREEN: Reads `LMSTUDIO_ENDPOINT` + `RELAY_EMBEDDING_MODEL` from env (overridable via opts)
    - GREEN: Empty `query.query` OR unset `RELAY_EMBEDDING_MODEL` → return `new Map()` immediately (no embed call, no warning)
    - GREEN: `embedQuery(query.query, { endpoint, model, timeoutMs: 5000, fetchImpl })`; on `{ ok: false }` → stderr warning (deduped) + empty Map
    - GREEN: For each candidate: require BOTH `embedding_blob` non-null AND `embedding_model === currentModel`; compute cosine; clamp `[0, 1]` before inserting
    - GREEN: Add `MemoryStore.getRawEmbeddings(ids: readonly string[]): Map<string, { blob: Buffer; model: string }>` — keeps helper free of SQL knowledge; mirrors `fetchByIds` shape
  </behavior>
  <action>
    `Memory` intentionally lacks `embedding_blob` (purity rule). Helper needs raw row data via new `MemoryStore.getRawEmbeddings(ids)` — single focused method, testable with in-memory stub store.

    Nomic v1.5 outputs L2-normalized per model card (NOMIC-EMBED-SPECS §1+§6). So `cosine == dot product`. Compute full cosine anyway (~100µs for 768 dims) — defensive against future model swaps.

    Stderr warning (PITFALL 2.4): `RELAY: embedding skipped (LM Studio /v1/embeddings ${reason}). Recall falling back to word-overlap. Run 'relay doctor' to check.` Deduped via `warnedReasons = new Set<string>()` at module scope.
  </action>
  <verify>
    <automated>npx vitest run src/memory/semantic-similarities.test.ts</automated>
  </verify>
  <done>Helper never throws; every failure path → empty Map + (deduped) warning; cross-model rejection works; cosine fixtures pass; no-query/no-env short-circuit (zero embed calls).</done>
</task>

### T6 — Wire helper into CLI + MCP

<task type="tdd" tdd="true">
  <name>T6: Wire computeSemanticSimilarities into cmd-memory-ops + cmd-memory-search + memory_search MCP + recall MCP</name>
  <files>src/cli/cmd-memory-ops.ts, src/cli/cmd-memory-search.ts, src/tools/memory_search.ts, src/tools/recall.ts, src/tools/memory_search.test.ts</files>
  <behavior>
    - RED (cmd-memory-ops): With mock fetch returning valid 768-dim, recall output's ScoreComponents.content reflects cosine (not word-overlap)
    - RED (cmd-memory-ops): With mock fetch failing, recall still returns memories (degraded), no throw
    - RED (MCP memory_search): `await handleMemorySearch(args)` returns same JSON shape but with similarity-driven scores
    - RED: ALL previously-passing tests for these handlers byte-identical when fetch unavailable in test env (regression guard)
    - GREEN (cmd-memory-ops): After `const candidates = store.getCandidates(query)`: `const similarities = await computeSemanticSimilarities(store, query, candidates); const result = budgetedRecall(candidates, query, Date.now(), similarities);`
    - GREEN (cmd-memory-search): Same pattern (already async per `cli.ts:561`)
    - GREEN (memory_search MCP): Convert `handleMemorySearch` to `async`; single `await` before `budgetedRecall`; response shape unchanged
    - GREEN (recall MCP): If `tools/recall.ts` calls `budgetedRecall` directly, apply same wire-up; otherwise no-op (verify during impl)
  </behavior>
  <action>
    Verify MCP caller awaits handler before changing signature (MCP SDK convention — same as `auto-extract-runner.ts` consumers).

    Tests injecting mock client use `RELAY_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5` + `vi.stubGlobal('fetch', mockFetch)` or pass `fetchImpl` via opts (mirrors `embedding-client.test.ts`).

    When fetch unavailable in test env, helper returns empty Map → `budgetedRecall` falls through to word-overlap path → ALL pre-existing fixtures produce identical numeric output. This is the regression guard.
  </action>
  <verify>
    <automated>npx vitest run src/cli/cmd-memory-ops.test.ts src/cli/cmd-memory-search.test.ts src/tools/memory_search.test.ts</automated>
  </verify>
  <done>All three (four if recall MCP applies) sites await helper before budgetedRecall; byte-identical results when fetch fails (regression-safe); similarity values flow through when fetch succeeds; `handleMemorySearch` async with no caller breaks.</done>
</task>

### T7 — Integration test: CSS naming (EMBED-05)

<task type="tdd" tdd="true">
  <name>T7: Integration — "naming conventions for stylesheets" → "kebab-case CSS"</name>
  <files>test/embeddings-wire-up.integration.test.ts (NEW)</files>
  <behavior>
    - Gated by `RELAY_INTEGRATION_LM_STUDIO=1` — `describe.skipIf(!integration)` (mirrors `auto-extract-runner.test.ts` integration pattern)
    - Fresh in-memory `MemoryStore`; `LMSTUDIO_ENDPOINT` + `RELAY_EMBEDDING_MODEL` set; writes 5 memories about CSS naming (varied phrasing):
      1. "Prefer kebab-case for CSS classes (e.g. .nav-link not .navLink)"
      2. "Use BEM block__element--modifier when components nest"
      3. "Avoid camelCase identifiers in stylesheet selectors"
      4. "ID selectors should be reserved for JS hooks, not styling"
      5. "Tailwind utility classes follow their own convention — leave them as-is"
    - After each remember: `await new Promise(r => setTimeout(r, 200))` to let UPDATE complete
    - Query: `await executeRecallCommand({ query: 'naming conventions for stylesheets', tokenBudget: 4000, workdir: testWorkdir }, captureIo)`
    - Assert: top 3 includes memory #1. Memory #1 has ZERO words in common with query ("naming"/"conventions"/"stylesheets" vs "kebab"/"CSS"/"classes") — word-overlap alone would NOT rank it top.
    - Assert: returned memory's `ScoreComponents.content > 0.5` (proves semantic ranking, not coincidence)
  </behavior>
  <action>
    Place at `test/embeddings-wire-up.integration.test.ts` (root `test/` for integration tier).

    Runbook at top of file:
    ```
    lms load text-embedding-nomic-embed-text-v1.5 && \
      RELAY_INTEGRATION_LM_STUDIO=1 \
      RELAY_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5 \
      LMSTUDIO_ENDPOINT=http://127.0.0.1:1234 \
      npx vitest run test/embeddings-wire-up.integration.test.ts
    ```

    Use unique workdir under `os.tmpdir()` per run (CC.3 workdir leak prevention).
  </action>
  <verify>
    <automated>RELAY_INTEGRATION_LM_STUDIO=1 RELAY_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5 npx vitest run test/embeddings-wire-up.integration.test.ts</automated>
  </verify>
  <done>Skips cleanly when integration env unset (CI default); passes when LM Studio loaded — memory #1 in top 3 despite zero word overlap; ScoreComponents.content > 0.5 on the kebab-case memory.</done>
</task>

### T8 (checkpoint) — Runtime validation against live LM Studio

<task type="checkpoint:human-verify" gate="blocking">
  <name>T8: Runtime validation — write/recall round-trip against live LM Studio</name>
  <what-built>Embed-on-write + similarity-driven recall active. `embedding_blob` populated lazily. CLI + MCP use cosine when present, word-overlap when not.</what-built>
  <how-to-verify>
1. `lms load text-embedding-nomic-embed-text-v1.5`
2. `export RELAY_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5`
3. `relay memory remember "prefer kebab-case for CSS class names" --type lesson` — expect: returns ~50ms with memory_id
4. Wait ~2s. `sqlite3 .relay/relay.db "SELECT memory_id, length(embedding_blob), embedding_model FROM memories ORDER BY created_at DESC LIMIT 1"` — expect: length=3072, model=text-embedding-nomic-embed-text-v1.5
5. `relay memory recall "naming conventions for stylesheets" --json` — expect: kebab-case memory in top results despite no word overlap; `score_components.content > 0.5`
6. `lms unload text-embedding-nomic-embed-text-v1.5`
7. Recall again — expect: still returns (word-overlap fallback); kebab-case may rank lower; one stderr line `RELAY: embedding skipped (LM Studio /v1/embeddings ...)`
8. `relay memory remember "test offline write"` with LM Studio offline — expect: returns ~50ms (sync); blob NULL; stderr warning (or suppressed by per-process dedup from step 7)
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues</resume-signal>
</task>

## Acceptance criteria (one per ROADMAP Phase 4 success criterion)

| # | Criterion (`ROADMAP.md:70-76`) | Evidence |
|---|---|---|
| 1 | 5 CSS memories → query "naming conventions for stylesheets" → "kebab-case" in top results despite zero word overlap | T7 green + T8 step 5 |
| 2 | `remember` returns sync; `get <id>` shows blob within ~1s | T2 lazy-UPDATE tests + T8 steps 3–4 |
| 3 | LM Studio offline → recall still works (word-overlap); blob NULL; stderr warning | T5 mock-failure tests + T8 steps 6–8 |
| 4 | `relay memory why <id>` shows ScoreComponents.content = semantic similarity when present | T3 ScoreComponents test; `cmd-memory-why.ts` already renders ScoreComponents — no change there |
| 5 | memory-engine.ts purity preserved; similarities computed at caller layer | T3/T4 + CI lint guard (Risk §5) |

## Runtime validation

Covered by T8. Pre-conditions: LM Studio on `127.0.0.1:1234`, `text-embedding-nomic-embed-text-v1.5` loaded, `RELAY_EMBEDDING_MODEL` env set, v0.2 schema applied (Phase 1).

## Risk register

| # | Risk | Likelihood | Blast | Mitigation | Owner |
|---|---|---|---|---|---|
| 1 | Silent NULL fallback (PITFALL 2.4) | MED | MED | Stderr-loud warning deduped per process per reason; `relay doctor` embedding coverage check (deferred to follow-up) | T2, T5 |
| 2 | Dimension mismatch / model swap (PITFALL 2.3) | LOW | MED | `embedding_model` column + cross-model rejection in helper; embedding-client asserts 768 dim | T1, T5 |
| 3 | Async microtask race in tests | MED | LOW | `queueMicrotask` (NOT `setImmediate`); deterministic single-tick flush; documented in source comment | T2 |
| 4 | `memory-engine.ts` purity erodes (PITFALL 2.1 + CC.4) | LOW | HIGH | CI lint: `grep -E "^import.*from '" src/memory/memory-engine.ts \| grep -vE "from './(types\|constants)"` MUST return zero. P0 if violated. | T3, T4 |
| 5 | `handleMemorySearch` sync→async breaks callers | LOW | MED | T6 verifies all callers already await | T6 |
| 6 | LM Studio bug #1546 (`usage.prompt_tokens` always 0) | LOW | LOW | Embedding-client already ignores `usage.*` | shipped |
| 7 | Big-endian platform corrupts BLOB | NEG | HIGH | embedding-client asserts LE host at module load (`:31-39`); throws immediately on BE | shipped |

## Pure-function preservation (CI lint reminder)

**Add to CI** (`package.json` `scripts.lint:engine-purity` or existing workflow):

```bash
grep -E "^import.*from '" src/memory/memory-engine.ts | grep -vE "from './(types|constants)"
# Expected: zero output. Non-zero = P0 violation.
```

Additionally:
- No `node:http`, `node-fetch`, `better-sqlite3`, `fs`, `child_process` imports in `memory-engine.ts`
- `scoreMemoryDetailed`, `scoreMemory`, `budgetedRecall` MUST remain sync (no `async` keyword)

Executor MUST run the grep after T3+T4 and confirm zero output before marking the plan complete.

## Pre-conditions confirmed during planning

- `src/memory/embedding-client.ts` exists at commit `a2b3a54` (428-line test file)
- `embedding_blob BLOB` ALREADY at `src/memory/db-migrations.ts:98-100` (commit `e3f3a9a`)
- `MemoryRow.embedding_blob: Buffer | null` ALREADY at `src/memory/types.ts:53`
- `embedding_model` NOT yet present — T1 adds
- `cmd-memory-recall` = `executeRecallCommand` in `src/cli/cmd-memory-ops.ts` (`cli.ts:314-345` already async)
- `handleMemorySearch` in `src/tools/memory_search.ts:22` currently sync — T6 converts
- `MemoryStore.getCandidates` sync (`memory-store.ts:585`) — PRESERVED

## Source audit

| Source | Item | Coverage |
|---|---|---|
| ROADMAP Goal | Wire embedding-client into recall without breaking sync semantics | T1–T6 |
| ROADMAP Success #1–5 | (see Acceptance table above) | T2, T3, T5, T7 + lint |
| REQUIREMENTS EMBED-01..05 | Lazy embed / opts / similarities / wire / integration | T2 / T3 / T4 / T5+T6 / T7 |
| RESEARCH §2.F4 | Wire embedText into recall; cosine; similarities map into scorer | T5 + T6 |
| RESEARCH §3 | F4 before F5 (calibrate cosine first) | This phase precedes Phase 5 per ROADMAP |
| PITFALLS 2.1 (pure-function break) | T3, T4, T5 boundary discipline + CI lint | Risk §4 |
| PITFALLS 2.2 (backward compat NULL embeddings) | T5 mixed-corpus + word-overlap fallback throughout | T5 |
| PITFALLS 2.3 (dim mismatch / model swap) | `embedding_model` col + cross-model rejection | T1 + T5 |
| PITFALLS 2.4 (silent NULL fallback) | Stderr-loud deduped per reason | T2 + T5 |
| PITFALLS 2.5 (cosine on unnormalized) | Fixture tests + clamp to [0,1] | T3 + T5 |
| User: "NO codex" | All tasks `type: tdd` | Honored |
| User: "TDD strict" | Every task RED→GREEN | Honored |
| User: "queueMicrotask not setImmediate" | T2 specifies queueMicrotask | Honored |
| User: "Don't touch src/workers/, src/runtime/store/db.ts" | Neither in files_modified | Honored |

No unplanned items. No phase split needed.

## Threat model

**Trust boundaries:** CLI/MCP → MemoryStore (user query text); MemoryStore → LM Studio (memory content reaches `/v1/embeddings`); LM Studio → MemoryStore (response vectors trusted only after dim + finite-number validation).

| ID | Category | Component | Disposition | Mitigation |
|---|---|---|---|---|
| T-04-01 | Tampering | Background microtask UPDATE | mitigate | `WHERE memory_id = ?` parameterized; memory_id is server-generated nanoid |
| T-04-02 | Info Disclosure | Stderr warning text | mitigate | Generic message — no query/workdir/content; per-process dedup |
| T-04-03 | DoS | LM Studio slow/hung → unawaited promises pile up | mitigate | embedding-client uses AbortController 5s timeout; rejected EmbeddingResults gc'd within 5s |
| T-04-04 | Info Disclosure | Query text to local `/v1/embeddings` | accept | Local-first by design (PROJECT.md); no remote egress |
| T-04-05 | Tampering | Malicious response corrupts store | mitigate | embedding-client validates 200, JSON-parseable, array of finite numbers, length === 768 |
| T-04-06 | Repudiation | Embed succeeds, UPDATE hits 0 rows (deleted between INSERT/UPDATE) | mitigate | Best-effort; blob=NULL falls back to word-overlap by design |
| T-04-07 | Spoofing | Other process on `127.0.0.1:1234` | mitigate | embedding-client probes `/v1/models` and asserts configured model loaded |

## Verification

- `npx vitest run` all green
- Engine purity lint returns zero: `grep -E "^import.*from '" src/memory/memory-engine.ts | grep -vE "from './(types|constants)"`
- T7 integration green when LM Studio loaded
- No new deps in `package.json`
- Pre-existing budget/recall/score tests remain green (regression guards in T3+T4)

## Success criteria

All 5 ROADMAP Phase 4 criteria proven (T7 + T8 + units); all 5 REQUIREMENTS EMBED-01..05 implemented; `memory-engine.ts` imports unchanged; `remember()` + `getCandidates()` remain sync; `handleMemorySearch` async conversion verified; zero new third-party deps.

## Output

After completion, create `.planning/phases/04-embeddings-wire-up/04-01-SUMMARY.md` documenting: files modified + line counts; test counts per task; patterns established (queueMicrotask for lazy embed, `ScoreOptions` interface, `computeSemanticSimilarities` impure boundary); decisions (queueMicrotask vs setImmediate; embedding_model row-level vs global; ScoreOptions vs Memory mutation); what Phase 5 (Conflict Detection) needs to know about cosine semantics; deferred follow-ups (`relay memory rebuild-embeddings` backfill, doctor `embedding_coverage` check).
