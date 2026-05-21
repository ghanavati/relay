---
phase: v0.2
plan: 4
type: tdd
wave: 1
depends_on: []
files_modified:
  - src/memory/db-migrations.ts
  - src/memory/types.ts
  - src/memory/embedding-client.ts            # NEW
  - src/memory/memory-store.ts
  - src/memory/memory-engine.ts
  - src/memory/embedding-client.test.ts       # NEW
  - src/memory/embeddings-migration.test.ts   # NEW
  - src/memory/score-memory.test.ts           # AUGMENT
  - src/memory/budgeted-recall.test.ts        # AUGMENT
  - src/memory/embeddings-recall.test.ts      # NEW
autonomous: true
requirements: [ROADMAP-§5]
must_haves:
  truths:
    - Memories table has a `embedding_blob` BLOB column (nullable, 3072 bytes when set)
    - `MemoryStore.remember()` returns synchronously and triggers lazy embedding backfill
    - A new memory written with LM Studio nomic loaded ends up with a 768-float `embedding_blob` within ≤1 s
    - `budgetedRecall()` ranks a memory by cosine similarity to query embedding when both vectors exist
    - Memory with NULL `embedding_blob` still scores via word-overlap (no regression)
    - Query "naming conventions for stylesheets" recalls memory "prefer kebab-case for CSS classes" even though zero query words appear in the memory
    - `memory-engine.ts` imports no I/O modules (still pure)
    - All 972 existing tests pass unchanged
  artifacts:
    - path: src/memory/embedding-client.ts
      provides: probe + embedDocument + embedQuery, never throws, 5s timeout
      exports: [embedDocument, embedQuery, probeEmbeddingsModel, EmbeddingResult]
    - path: src/memory/db-migrations.ts
      provides: PRAGMA-guarded ALTER adding `embedding_blob BLOB`
      contains: "ADD COLUMN embedding_blob BLOB"
    - path: src/memory/memory-engine.ts
      provides: cosineSim helper + ScoreOptions param threading
      exports: [cosineSim, ScoreOptions, scoreMemoryDetailed, scoreMemory, budgetedRecall]
  key_links:
    - from: src/memory/memory-store.ts (remember)
      to: src/memory/embedding-client.ts (embedDocument)
      via: setImmediate-scheduled UPDATE (lazy backfill, sync remember preserved)
      pattern: "embedDocument.*then.*UPDATE memories SET embedding_blob"
    - from: src/memory/memory-store.ts (getCandidates)
      to: src/memory/embedding-client.ts (embedQuery)
      via: single fetch before scoring; build Map<memory_id, similarity>
      pattern: "embedQuery.*similarities"
    - from: src/memory/memory-store.ts (getCandidates)
      to: src/memory/memory-engine.ts (budgetedRecall)
      via: pass similarities map as new optional param
      pattern: "budgetedRecall.*similarities"
---

## Goal

Replace word-overlap content scoring in `budgetedRecall()` with cosine similarity over
nomic-embed-text-v1.5 (768-dim float32) embeddings stored on the memories table, while
preserving:

1. Pure-function design of `memory-engine.ts` (no I/O inside scoring).
2. Synchronous `MemoryStore.remember()` signature (no async cascade).
3. Backward compatibility for rows with no embedding (NULL → fall back to word-overlap).

Cosine becomes the `content` score component (weight 0.15) when available; word-overlap
remains the fallback path. Engine receives pre-computed similarities as an optional
parameter — never calls the LM Studio client itself.

---

## Corrections to source artifacts

The plan **deviates** from ROADMAP/EMBEDDING-PATTERN on three points. All three are the
user's stated decisions:

| # | Source claim | Plan instead | Reason |
|---|---|---|---|
| C1 | ROADMAP §5 line 157: "Files to touch: ... `memory-engine.ts`, `memory-store.ts`" — implies write call lives in auto-extract or extract-runner | Embedding generation goes in `memory-store.remember()` (`src/memory/memory-store.ts:273-348`) | `auto-extract-runner.ts` is the chat-completions wrapper; it never calls `remember()`. EMBEDDING-PATTERN.md §6 confirms this. |
| C2 | EMBEDDING-PATTERN.md §2: `embedding_json TEXT` (JSON-serialized array) | `embedding_blob BLOB` (raw little-endian float32) | NOMIC-EMBED-SPECS §5: 3 KB BLOB vs ~14 KB JSON — 4.5× bloat for zero benefit at 100k rows (307 MB vs 1.4 GB). |
| C3 | EMBEDDING-PATTERN.md §6: "make `remember` async (cascades) OR background micro-task" | Lazy backfill — sync INSERT first, scheduled async UPDATE (`setImmediate`) | Avoids touching every `remember()` caller. Sync `remember()` preserved. |

Column name in this plan: `embedding_blob` (BLOB). Any source artifact reference to
`embedding_json` is superseded by `embedding_blob`.

---

## Files to touch

**New:**
- `src/memory/embedding-client.ts` — LM Studio `/v1/embeddings` wrapper (probe + embed + timeout)
- `src/memory/embedding-client.test.ts` — fetch-mock unit tests
- `src/memory/embeddings-migration.test.ts` — PRAGMA migration idempotency
- `src/memory/embeddings-recall.test.ts` — integration: write 5 memories, query unrelated wording, assert recall hit

**Modified:**
- `src/memory/db-migrations.ts` — PRAGMA-guarded ALTER add `embedding_blob BLOB`
- `src/memory/types.ts` — extend `MemoryRow` and `Memory` interfaces
- `src/memory/memory-store.ts` — `rowToMemory`, `remember`, `upsert`, `getCandidates`
- `src/memory/memory-engine.ts` — add `cosineSim`, `ScoreOptions`, thread similarities through `scoreMemoryDetailed`/`scoreMemory`/`budgetedRecall`
- `src/memory/score-memory.test.ts` — augment with `semanticSimilarity` cases
- `src/memory/budgeted-recall.test.ts` — augment with partial-similarities-map case

---

## Task breakdown (strict TDD — RED → GREEN → REFACTOR)

### T1 — Migration: add `embedding_blob` column (PRAGMA-guarded)

**Files:** `src/memory/db-migrations.ts:69-93` (add at end of Phase 2 PRAGMA block),
`src/memory/embeddings-migration.test.ts` (NEW)

**RED — write failing tests first:**

1. Open in-memory `better-sqlite3` DB, run base CREATE (without `embedding_blob`).
2. Assert `PRAGMA table_info(memories)` does NOT include `embedding_blob`.
3. Run `migrateMemoryTables(db)`.
4. Assert column now exists with type `BLOB` and `notnull=0` (nullable).
5. Run `migrateMemoryTables(db)` a **second time** — assert no throw, column still BLOB,
   no duplicate.
6. Insert a row with embedding NULL → read back → assert `embedding_blob === null`.

**GREEN — minimal patch** to `db-migrations.ts` immediately after `files_json` guard
(`src/memory/db-migrations.ts:91-93`):
```
if (!existingCols.has('embedding_blob')) {
  db.prepare('ALTER TABLE memories ADD COLUMN embedding_blob BLOB').run();
}
```

No index. No `NOT NULL`. No `DEFAULT`. Nullable BLOB.

**Verify:** `npm test -- --filter=embeddings-migration` passes. All existing migration
tests still pass.

**Done:** Two consecutive `migrateMemoryTables(db)` calls are idempotent; column visible
in `PRAGMA table_info`.

---

### T2 — New file `src/memory/embedding-client.ts` (never-throws wrapper)

**Files:** `src/memory/embedding-client.ts` (NEW), `src/memory/embedding-client.test.ts` (NEW)

**RED — write fetch-mocked tests first** (mirrors `auto-extract-runner.test.ts` style):

Test cases (use `globalThis.fetch` mock injected via param to keep functions pure):

1. `probeEmbeddingsModel(endpoint, model)` returns `{ ok: true }` when `GET /v1/models`
   returns `200` with model id in `data[].id` array.
2. `probeEmbeddingsModel` returns `{ ok: false, reason: 'not-loaded' }` when model absent.
3. `probeEmbeddingsModel` returns `{ ok: false, reason: 'unreachable' }` on
   `ECONNREFUSED`.
4. `embedDocument(text, opts)` POSTs `{ model, input: 'search_document: <text>' }` —
   assert body matches exactly, including `search_document: ` prefix (with trailing
   space — NOMIC-EMBED-SPECS §8).
5. `embedQuery(text, opts)` uses `search_query: ` prefix (with trailing space).
6. Both return `{ ok: true, vector: Float32Array(768) }` on a well-formed response.
7. **Dimension assertion:** if response `data[0].embedding.length !== 768`, return
   `{ ok: false, reason: 'wrong-dim', got: N }` and do NOT return the vector
   (NOMIC-EMBED-SPECS §9 — "Wrong model loaded" failure mode).
8. Timeout: simulate 6 s delay → 5 s `AbortController` fires → returns
   `{ ok: false, reason: 'timeout' }`. Never throws.
9. Malformed JSON: `JSON.parse` throws → caught → returns
   `{ ok: false, reason: 'parse-error' }`. Never throws.
10. HTTP 500: returns `{ ok: false, reason: 'http-500' }`. Never throws.
11. Empty input string: short-circuits, returns
    `{ ok: false, reason: 'empty-input' }` without HTTP call.
12. `usage.prompt_tokens` field is IGNORED (LM Studio bug #1546 — always 0).

**GREEN — implement** mirroring `auto-extract-runner.ts:91-137` (probe) and
`auto-extract-runner.ts:145-201` (POST with `AbortController`):

Exports:
```
export interface EmbeddingResult {
  readonly ok: boolean;
  readonly vector?: Float32Array;
  readonly reason?: 'empty-input' | 'unreachable' | 'timeout' | 'http-500' | 'http-4xx'
                  | 'parse-error' | 'wrong-dim' | 'not-loaded' | 'no-data';
  readonly got?: number;       // populated when reason === 'wrong-dim'
}

export interface EmbedOptions {
  readonly endpoint: string;   // e.g. http://localhost:1234
  readonly model: string;      // e.g. text-embedding-nomic-embed-text-v1.5
  readonly timeoutMs?: number; // default 5000
  readonly fetchImpl?: typeof fetch;  // for tests
}

export async function probeEmbeddingsModel(opts: EmbedOptions): Promise<EmbeddingResult>;
export async function embedDocument(text: string, opts: EmbedOptions): Promise<EmbeddingResult>;
export async function embedQuery(text: string, opts: EmbedOptions): Promise<EmbeddingResult>;
```

Internal:
- `trimEndpoint` (copy from `auto-extract-runner.ts:61-63`)
- `EXPECTED_DIM = 768` constant
- `STORE_PREFIX = 'search_document: '`, `QUERY_PREFIX = 'search_query: '`
- Both `embedDocument` and `embedQuery` delegate to a private `embedWithPrefix(prefix, text, opts)`
- No `temperature`/`top_p` in request body (NOMIC-EMBED-SPECS §3 — not applicable to embeddings)
- Convert `number[]` from JSON → `Float32Array` (3 KB) at the boundary

**Env vars to read** (in caller, not client — keeps client pure):
- `LMSTUDIO_ENDPOINT` (reuse — auto-extract already reads it)
- `RELAY_EMBEDDING_MODEL` (NEW; if unset → feature off, no embedding calls)

**Verify:** `npm test -- --filter=embedding-client` passes. No fetch reaches network in
unit tests (assert via mock call count).

**Done:** Client never throws; returns typed `EmbeddingResult` with `Float32Array(768)` on
success or a `reason` string on failure.

---

### T3 — `MemoryStore.remember()` lazy backfill (sync API preserved)

**Files:** `src/memory/memory-store.ts:273-348` (`remember`), `:360-455` (`upsert`),
`:78-104` (`rowToMemory`), `src/memory/types.ts:31` (`MemoryRow`) + `:55` (`Memory`)

**RED — extend existing `MemoryStore` tests** in `src/memory/memory-store.test.ts`:

1. `remember()` still returns a `memory_id` synchronously (regression).
2. When `RELAY_EMBEDDING_MODEL` is unset, no embedding is generated; row's
   `embedding_blob` stays NULL forever.
3. When `RELAY_EMBEDDING_MODEL` set + mocked embedding client returns 768-float vector:
   row exists immediately with NULL embedding, then within 1 tick (`await
   Promise.resolve(); await Promise.resolve();`) row's `embedding_blob` is non-null,
   length 3072 bytes (= 768 × 4).
4. If embedding client returns `ok: false` (e.g., LM Studio down): row stays with NULL
   `embedding_blob`. No throw. No retry storm (single attempt per write).
5. `upsert()` follows the same pattern as `remember()`.

**GREEN — implementation:**

**Type changes** (`src/memory/types.ts`):
- `MemoryRow` — add `readonly embedding_blob: Buffer | null;` (better-sqlite3 returns BLOB
  as `Buffer`).
- `Memory` — add `readonly embedding: Float32Array | null;` (parsed view; immutable
  by convention, do not mutate the underlying buffer).

**`rowToMemory`** (`memory-store.ts:78`):
- Decode: if `row.embedding_blob !== null && row.embedding_blob.length === 3072`, wrap as
  `new Float32Array(row.embedding_blob.buffer, row.embedding_blob.byteOffset, 768)`.
- Else `embedding: null`.
- Guard byte-order: assert `row.embedding_blob.length === 3072` — if mismatch, treat as
  null and log once (do not throw).

**INSERT in `remember`** (`memory-store.ts:315-344`):
- Column list grows from 18 → 19. Add `embedding_blob` at the end with bound value `null`
  (insert sync first, populate later).

**Lazy backfill helper** — add to `MemoryStore` private methods:
```
private scheduleEmbeddingBackfill(memoryId: string, content: string): void
```
- Read `process.env.RELAY_EMBEDDING_MODEL` once at call time; if absent, return.
- `setImmediate(async () => { ... })` — schedule async without blocking caller.
- Inside callback:
  1. `const result = await embedDocument(content, { endpoint, model, timeoutMs: 5000 });`
  2. If `!result.ok || !result.vector`, return silently (log at debug level).
  3. Convert `Float32Array` → `Buffer` via
     `Buffer.from(result.vector.buffer, result.vector.byteOffset, result.vector.byteLength)`.
  4. Assert `buffer.length === 3072` (defensive — wrong-dim should have been caught in
     client, but redundancy is cheap).
  5. `db.prepare('UPDATE memories SET embedding_blob = ? WHERE memory_id = ?').run(buffer, memoryId)`.
  6. Wrap UPDATE in try/catch — swallow (e.g., DB closed during shutdown).

- Call site in `remember()`: invoke `this.scheduleEmbeddingBackfill(id, content)`
  after the INSERT but before `gcByTokenBudget()` (avoid scheduling for rows that
  immediately get GC'd — but GC runs synchronously here so order is moot;
  schedule after INSERT regardless).

- Call site in `upsert()`: same — after the new row's INSERT.

**Byte-order:** Node's `Buffer.from(Float32Array.buffer)` uses host byte-order; on x86_64
and Apple Silicon both are little-endian. **Explicitly assert** little-endian at module
load:
```
const probe = new Uint8Array(new Float32Array([1.0]).buffer);
if (probe[0] !== 0x00 || probe[3] !== 0x3f) {
  throw new Error('embedding-client: big-endian platform not supported');
}
```
This goes in `embedding-client.ts` (or a shared `embedding-codec.ts` if you prefer; for
this plan, inline in client).

**Verify:** `npm test -- --filter=memory-store` passes. Add explicit assertions: BLOB
length === 3072 after backfill, NULL when model env unset.

**Done:** `remember()` API unchanged. Embedding lands within 1 event-loop tick when LM
Studio responds; row remains usable (with NULL embedding) when LM Studio is down.

---

### T4 — `memory-engine.scoreMemoryDetailed` optional `ScoreOptions` param (pure)

**Files:** `src/memory/memory-engine.ts:59-72` (keep — fallback), `:115` (signature),
`:179` (wrapper signature), augment `src/memory/score-memory.test.ts`

**RED — augment existing pure-engine tests:**

1. Existing test: `scoreMemoryDetailed(m, q, now)` (3-arg) produces identical
   `ScoreBreakdown` as before — byte-for-byte regression. (No-op coverage; proves
   backward compat.)
2. `scoreMemoryDetailed(m, q, now, { semanticSimilarity: 0.9 })` with a memory where
   word-overlap = 0 (no shared tokens) → `components.content === 0.9 * 0.15 === 0.135`.
   Compare to same call with no opts: `components.content === 0`.
3. `scoreMemoryDetailed(m, q, now, { semanticSimilarity: 0.0 })` → `components.content
   === 0` (explicit zero, not fallback).
4. `scoreMemoryDetailed(m, q, now, { semanticSimilarity: undefined })` → behaves
   identically to 3-arg call (no opts passed).
5. No-query branch (`query.query === undefined`): `semanticSimilarity` is **ignored**
   regardless of value (no-query path forces content to 0 — preserve existing behavior at
   `memory-engine.ts:135-143`).
6. Comparative assertion (existing style at `score-memory.test.ts:43-50`): memory A with
   `semanticSimilarity=0.9` and zero word overlap **beats** memory B with
   `semanticSimilarity=undefined` and full word overlap — proves the new path actually
   wins when warranted.

**Add `cosineSim` test** (also lives in `score-memory.test.ts` or a sibling file):

7. `cosineSim(Float32Array, Float32Array)` returns 1.0 for identical vectors, 0.0 for
   orthogonal, -1.0 for anti-parallel.
8. Empty input → 0. Length mismatch → 0. All-zeros input → 0 (avoid NaN).
9. Result is clamped to `[0, 1]` (anti-parallel returns 0, not -1) — Relay treats negative
   similarity as "no signal" rather than "anti-relevance".

**GREEN — implementation:**

Add at top of `memory-engine.ts`:
```
export interface ScoreOptions {
  readonly semanticSimilarity?: number;   // raw [0,1] (caller clamps)
}

export function cosineSim(a: Float32Array | readonly number[], b: Float32Array | readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!, bi = b[i]!;
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  const raw = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(0, Math.min(1, raw));
}
```

Update `scoreMemoryDetailed` (`memory-engine.ts:115`):
```
export function scoreMemoryDetailed(
  memory: Memory,
  query: RecallQuery,
  now: number,
  opts?: ScoreOptions
): ScoreBreakdown
```

Replace line 117:
```
const contentScore = opts?.semanticSimilarity !== undefined
  ? opts.semanticSimilarity
  : computeContentScore(memory.content, query.query);
```

Update `scoreMemory` wrapper at line 179:
```
export function scoreMemory(
  memory: Memory, query: RecallQuery, now: number, opts?: ScoreOptions
): number {
  return scoreMemoryDetailed(memory, query, now, opts).total;
}
```

**Engine purity guard** — add a test that imports `memory-engine.ts` and asserts the
module's imports contain no `fetch`, no `http`, no `better-sqlite3`, no
`embedding-client`. (Optional but cheap: regex over the source file.)

**Verify:** `npm test -- --filter=score-memory` passes. All pre-existing assertions
unchanged.

**Done:** `memory-engine.ts` imports no I/O. `ScoreOptions` is the only new public surface
on the scoring functions.

---

### T5 — `budgetedRecall` accepts `similarities`; `getCandidates` produces it

**Files:** `src/memory/memory-engine.ts:195-225` (`budgetedRecall`),
`src/memory/memory-store.ts:585-612` (`getCandidates`),
augment `src/memory/budgeted-recall.test.ts`

**RED — engine test additions** (pure, no DB):

1. `budgetedRecall(memories, query, now)` (3-arg) unchanged regression.
2. `budgetedRecall(memories, query, now, similarities)` where `similarities` is empty Map
   → identical to 3-arg.
3. `budgetedRecall(memories, query, now, similarities)` with map covering half the rows:
   covered rows use semantic path, uncovered rows use word-overlap. Both contribute
   to the final ranking. (Mixed-corpus correctness — matches EMBEDDING-PATTERN.md §5.)
4. Comparative: same corpus, two calls — one with empty similarities, one where the
   "semantically relevant but lexically disjoint" memory has `similarity=0.85`. Second
   call ranks that memory above a lexically-matching but semantically-weak memory.

**GREEN — engine change** (`memory-engine.ts:195-225`):
```
export function budgetedRecall(
  memories: readonly Memory[],
  query: RecallQuery,
  now: number,
  similarities?: ReadonlyMap<string, number>
): RecallResult
```

Internal map step at line 196-199:
```
const scored: ScoredMemory[] = memories.map(m => {
  const sim = similarities?.get(m.memory_id);
  const opts = sim !== undefined ? { semanticSimilarity: sim } : undefined;
  return { ...m, score: scoreMemory(m, query, now, opts) };
});
```

Everything else (sort, MIN_RELEVANCE_SCORE filter, greedy pack) unchanged.

**RED — store-side integration test** in `src/memory/embeddings-recall.test.ts` (NEW):

This is the **acceptance test** for the whole plan. Real `better-sqlite3` + mocked
`embedding-client`:

1. Stand up in-memory DB, run `migrateMemoryTables`.
2. Mock `embedDocument` and `embedQuery` to return deterministic vectors:
   - Memory M1 content "prefer kebab-case for CSS classes" → vector V1
   - Memory M2 content "use 2-space indentation for JS" → vector V2 (orthogonal to V1)
   - Memory M3 content "naming convention is dashes for stylesheets" → vector V3 (close
     to V1; cosine ≥ 0.85)
   - Memories M4, M5 → orthogonal noise vectors
   - Query "naming conventions for stylesheets" → vector Q (close to V1 and V3, far
     from V2)
3. Call `store.remember()` for all 5 memories. Await two ticks for backfill.
4. Call `store.getCandidates({ query: 'naming conventions for stylesheets', token_budget: 5000 })`.
5. Call `budgetedRecall(...)` with the candidates and the similarities map produced
   from `embedQuery(query)` cosine'd against each candidate's embedding.
6. **Assert** M1 (kebab-case for CSS) is in the result set despite **zero query
   words** appearing in its content (only "kebab", "case", "css", "classes" appear —
   no "naming", "conventions", "stylesheets").
7. **Assert** M2 (indentation) is NOT in the result set OR scores well below M1.
8. Fallback test: insert M6 with `embedding_blob = NULL` (simulating legacy row).
   Query "indentation rules" (word overlap with M2). Assert M2 still recalled (word-
   overlap path active for rows lacking embedding).

**GREEN — `getCandidates` change** (`memory-store.ts:585-612`):

After the existing candidate fetch (FTS path at `:588-601` or recency path at `:606`):

```ts
// NEW: only when feature enabled
const model = process.env.RELAY_EMBEDDING_MODEL;
let similarities: Map<string, number> | undefined;
if (model && query.query && query.query.trim().length > 0) {
  const endpoint = process.env.LMSTUDIO_ENDPOINT ?? 'http://localhost:1234';
  const queryResult = await embedQuery(query.query, { endpoint, model, timeoutMs: 5000 });
  if (queryResult.ok && queryResult.vector) {
    similarities = new Map();
    for (const m of candidates) {
      if (m.embedding) {
        similarities.set(m.memory_id, cosineSim(queryResult.vector, m.embedding));
      }
    }
  }
}
```

**But:** `getCandidates` is currently SYNCHRONOUS (`better-sqlite3` is sync). Adding
`await embedQuery(...)` makes it async — cascade risk.

**Decision:** `getCandidates` returns `Memory[]` and does NOT call the engine. The
embedding/similarity logic lives at the call sites that do invoke `budgetedRecall` —
specifically `cmd-memory-recall.ts`, `src/tools/memory_search.ts`, `loadRecalledLessonsContent`,
and any other recall consumer. Those call sites are already async (CLI handlers).

**Refactor:** introduce a new public helper on `MemoryStore`:
```
public async computeSemanticSimilarities(
  query: string,
  candidates: readonly Memory[]
): Promise<ReadonlyMap<string, number> | undefined>
```

This is the **only** async addition. `remember()`, `upsert()`, `getCandidates()` all stay
sync. Recall call sites do:
```ts
const candidates = store.getCandidates(query);
const sims = await store.computeSemanticSimilarities(query.query, candidates);
const result = budgetedRecall(candidates, query, Date.now(), sims);
```

**Audit call sites** during implementation — grep `budgetedRecall\(` and update each
caller to await the similarities helper if relevant. Call sites that do NOT pass a `query`
(no-query recall path) skip the helper entirely (similarities only matter when query is
present).

**Verify:** `npm test -- --filter=embeddings-recall` passes. `npm test -- --filter=budgeted-recall` passes.

**Done:** M1 recalled against M2 on a query with zero lexical overlap. M6 (NULL
embedding) still recalled via word-overlap on lexically-matching query.

---

### T6 — Integration: writes & recall against a real (mocked) LM Studio

Already covered by T5's `embeddings-recall.test.ts`. No separate task.

---

### T7 — Fallback regression: NULL embedding rows still score

Already covered by T5 step 8. No separate task. Verify the assertion appears in the
test file.

---

## Acceptance criteria

- [ ] All 972 existing tests pass (regression).
- [ ] New test: query "naming conventions for stylesheets" recalls memory "prefer
      kebab-case for CSS classes" (semantic match, zero lexical overlap).
- [ ] New test: memory with NULL `embedding_blob` still scores via word-overlap on a
      lexically-matching query (fallback).
- [ ] Migration is idempotent (running `migrateMemoryTables` twice on an existing DB
      does not throw and does not duplicate the column).
- [ ] `MemoryStore.remember()` signature unchanged — returns `string` synchronously.
- [ ] When `RELAY_EMBEDDING_MODEL` is unset, no embedding generation occurs (verified by
      asserting zero fetch calls).
- [ ] `memory-engine.ts` source contains no `import` of `fetch`, `http`, `node:http`,
      `better-sqlite3`, or `embedding-client` (purity guard).
- [ ] Embedding BLOB length is exactly 3072 bytes (768 × 4) for every populated row.
- [ ] `embedding-client.ts` never throws — every public function returns
      `EmbeddingResult` with `ok` and optional `reason`.

---

## Runtime validation (manual smoke test before merge)

Run on dev machine with LM Studio installed:

```bash
lms load text-embedding-nomic-embed-text-v1.5 -y
export LMSTUDIO_ENDPOINT=http://localhost:1234
export RELAY_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5

relay memory remember "prefer kebab-case for CSS class names" --type fact --tags css
relay memory remember "use 2-space indentation for TypeScript" --type fact --tags ts
relay memory remember "always pin dependencies in package.json" --type fact --tags deps

# Wait 1 second for backfill (lazy UPDATE).
sleep 1

# Verify embeddings landed:
sqlite3 ~/.relay/db.sqlite "SELECT memory_id, length(embedding_blob) FROM memories
  WHERE memory_id IN (SELECT memory_id FROM memories ORDER BY created_at DESC LIMIT 3);"
# Expect: three rows, each length=3072.

# Semantic recall — query uses words ABSENT from the memory:
relay memory recall "naming conventions for stylesheets" --json
# Expect: kebab-case memory in `memories[]` despite zero word overlap.

# Fallback — turn off the model and recall again:
unset RELAY_EMBEDDING_MODEL
relay memory recall "kebab-case" --json
# Expect: same memory recalled via word-overlap path.
```

If LM Studio is not running, recall must still return word-overlap results with no error
output.

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Nomic model not loaded in LM Studio | Medium | Medium | `embedding-client` returns `ok: false, reason: 'not-loaded'`; recall falls back to word-overlap; `relay memory recall` logs a one-line debug hint at most once per process |
| R2 | Embedding latency adds to write path | Low (lazy) | Low | Lazy backfill — sync `remember()` returns immediately; `setImmediate` defers HTTP call; backfill failures swallowed |
| R3 | BLOB byte-order mismatch on big-endian host | Very Low | High | Module-load assertion in `embedding-client.ts` throws on big-endian; documented as unsupported. Apple Silicon and x86_64 are little-endian. |
| R4 | Wrong-dim embedding (different model swapped in) | Low | High | `embedding-client` asserts `data[0].embedding.length === 768` per response; returns `{ ok: false, reason: 'wrong-dim', got: N }`; never stored |
| R5 | `usage.prompt_tokens` always 0 (LM Studio #1546) | Confirmed | None | Don't trust it. No token accounting based on embedding usage. |
| R6 | `getCandidates` made async, breaking sync callers | Medium | Medium | `getCandidates` stays sync; new async work isolated in `computeSemanticSimilarities` helper; audit `budgetedRecall(` call sites during implementation |
| R7 | Lazy backfill misses rows if process exits mid-tick | Low | Low | Backfill is best-effort; missed rows have NULL embedding and use word-overlap. Optional follow-up: `relay memory embed-backfill` CLI (deferred per EMBEDDING-PATTERN.md §9 step 8) |
| R8 | LM Studio at unexpected port | Low | Medium | `LMSTUDIO_ENDPOINT` env var; default `http://localhost:1234` matches LM Studio default |
| R9 | Test fixture vectors drift from real nomic output | Low | Low | Integration test mocks the client entirely (deterministic vectors); real LM Studio call only in manual smoke (not CI) |
| R10 | FTS5 candidate cap (500) hides semantically-similar rows | Medium | Low | Documented limitation. Embeddings re-rank within the FTS-narrowed set; widening the candidate window is a separate concern. |

---

## Out of scope for this plan (deferred follow-ups)

- `consolidation.ts` cosine swap (EMBEDDING-PATTERN.md §10 "explicitly does NOT do").
- `relay memory embed-backfill` CLI (EMBEDDING-PATTERN.md §9 step 8) — useful but
  optional; existing rows backfill on next `remember()` cycle anyway via no path… so
  the CLI is the only retro-fill path. Flag for v0.2.1 if needed.
- Matryoshka truncation (256-dim) — current plan stores full 768. Re-evaluate after
  benchmarking on real corpus.
- Query-result LRU cache (NOMIC-EMBED-SPECS §7) — embed fresh per recall.
- Dimension/quant tagging per row (NOMIC-EMBED-SPECS §9 R7) — deferred until we
  consider swapping models.
- `vec_distance_cosine` / sqlite-vec extension — pure-JS cosine sufficient at ≤500
  candidates per recall.
