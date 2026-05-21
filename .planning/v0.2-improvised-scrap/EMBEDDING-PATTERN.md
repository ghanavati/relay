# EMBEDDING-PATTERN.md — Semantic scoring (ROADMAP §5)

**Scope:** wire LM Studio embeddings + cosine similarity into existing pure scoring without breaking the engine's pure-function contract.

**Files in play** (all absolute):
- `/Users/ghanavati/ai-stack/Projects/Relay/src/memory/memory-engine.ts` (pure scorer — modify signature)
- `/Users/ghanavati/ai-stack/Projects/Relay/src/memory/memory-store.ts` (write path + getCandidates — call embed)
- `/Users/ghanavati/ai-stack/Projects/Relay/src/memory/db-migrations.ts` (PRAGMA-guarded ALTER for `embedding_json`)
- `/Users/ghanavati/ai-stack/Projects/Relay/src/memory/types.ts` (extend `Memory`, `MemoryRow`)
- `/Users/ghanavati/ai-stack/Projects/Relay/src/memory/auto-extract-runner.ts` (existing LM Studio wrapper — extract probe/fetch pattern for new embeddings client)
- `/Users/ghanavati/ai-stack/Projects/Relay/src/runtime/store/db.ts` (no change — `migrateMemoryTables` already wired at line 418)

---

## 1. Current `computeContentScore` — full body & return range

`memory-engine.ts:59-72`:

```typescript
function computeContentScore(content: string, query: string | undefined): number {
  if (!query || query.trim().length === 0) return 0;
  const contentLower = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return 0;
  let matches = 0;
  for (const word of words) {
    if (contentLower.includes(word)) matches++;
  }
  return matches / words.length;   // [0, 1] inclusive — 0 = no overlap, 1 = every query word found
}
```

**Range:** `[0.0, 1.0]`. Returns `0` when `query` is missing/empty OR when no query words exceed 2 chars. Returns `matches / words.length` otherwise — strictly bounded since `matches <= words.length`.

**Called by:** `scoreMemoryDetailed` exactly once at `memory-engine.ts:117`:
```typescript
const contentScore = computeContentScore(memory.content, query.query);
```

**Used in:** both score branches.
- *Query branch* (line 150): `content: contentScore * 0.15` — weighted 15% of total.
- *No-query branch* (line 135-143): `content: 0` (forced to zero — the no-query path ignores content match entirely).

`scoreMemory` (line 179-181) is the thin wrapper that returns `scoreMemoryDetailed(...).total`.

---

## 2. Schema attachment — where `embedding_json` lives

Memories table is defined in **`src/memory/db-migrations.ts`**, NOT `src/runtime/store/db.ts`. The runtime db.ts is only an aggregator: `applySchema` at line 406-427 calls `migrateMemoryTables(db)` at line 418.

`db-migrations.ts:16-32` — the base CREATE TABLE block (no embedding column yet):

```typescript
`CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  workdir TEXT,
  token_count INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  source_run_id TEXT,
  git_ref TEXT,
  superseded_by TEXT,
  created_at INTEGER NOT NULL,
  accessed_at IEGER NOT NULL,
  expires_at INTEGER,
  entity_key TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]'
)`,
```

**Add `embedding_json` via PRAGMA-guarded ALTER in `migrateMemoryTables` block (line 59+), following the existing pattern at lines 78-93:**

```typescript
// AFTER existing files_json guard (line 91-93)
if (!existingCols.has('embedding_json')) {
  db.prepare('ALTER TABLE memories ADD COLUMN embedding_json TEXT').run();
}
```

No index needed (cosine is computed in JS per candidate). Add it as a nullable TEXT column; values are JSON-stringified `number[]`.

---

## 3. Pure-function preservation — threading similarity in

**ROADMAP §5 explicit constraint** (line 152-153): *"The pure-function design of `memory-engine.ts` is preserved: pass the pre-computed similarity in as a parameter rather than computing it inside the scoring function."*

The engine **must not import** any HTTP client, DB, or LM Studio code. All embedding work happens upstream in `memory-store.ts::getCandidates()` (after the FTS5 candidate fetch, before passing to engine). The engine receives a `Map<memory_id, similarity>` or per-memory `semanticSimilarity?: number` and uses it as an alternative `content` signal.

**Decision:** pass as an optional per-call parameter (third argument to a new opts object), not as a property mutation on `Memory`. Keeps `Memory` immutable and DB-shape-only.

---

## 4. Exact signature change

**Current** (`memory-engine.ts:115`):
```typescript
export function scoreMemoryDetailed(
  memory: Memory,
  query: RecallQuery,
  now: number
): ScoreBreakdown
```

**Proposed:**
```typescript
export interface ScoreOptions {
  readonly semanticSimilarity?: number;   // [0, 1] cosine sim, undefined = use word-overlap fallback
}

export function scoreMemoryDetailed(
  memory: Memory,
  query: RecallQuery,
  now: number,
  opts?: ScoreOptions
): ScoreBreakdown
```

**Internal change at line 117:**
```typescript
const contentScore = opts?.semanticSimilarity !== undefined
  ? opts.semanticSimilarity                              // semantic path
  : computeContentScore(memory.content, query.query);    // fallback
```

**`scoreMemory` wrapper** (line 179) gets the same optional `opts` param and forwards.

**`budgetedRecall`** (line 195) gains an optional `similarities?: ReadonlyMap<string, number>` parameter; per-memory lookup at line 198:
```typescript
const sim = similarities?.get(m.memory_id);
scoreMemory(m, query, now, sim !== undefined ? { semanticSimilarity: sim } : undefined)
```

**Backward compatibility:** all existing test calls (`scoreMemory(m, q, now)` and `budgetedRecall(ms, q, now)`) continue to compile and produce identical results — the new param is optional and absent means "use word-overlap exactly as before".

---

## 5. Fallback strategy (null `embedding_json`)

**Per-row, per-query, with two trigger conditions:**

1. **Row has no embedding** (`memory.embedding_json === null`): omit that row's id from the `similarities` map passed to `budgetedRecall`. Engine sees `opts?.semanticSimilarity === undefined` → falls through to `computeContentScore`. Mixed corpus works (legacy + new).

2. **Query embed failed** (LM Studio down, timeout, or `embedding_json` column absent in older DBs): `getCandidates` skips the embedding fetch entirely and passes no `similarities` map. All rows fall back to word-overlap. No throw — same graceful-degradation policy as `auto-extract-runner.ts` (`status: 'error:llm-down'` never raises).

This matches the current FTS5 fallback in `memory-store.ts:588-601` (try FTS, on throw fall through to recency ordering).

---

## 6. Auto-extract-runner.ts is NOT the embedding insertion point

**Clarification:** `auto-extract-runner.ts` is the LM Studio **chat-completions** wrapper for lesson extraction from transcripts. It does not call `remember()`. The remember() flow is in `memory-store.ts:273-348`.

**Embedding generation insertion point** — `memory-store.ts::remember()`, after `sanitizeContent` (line 291) and before the INSERT (line 315):

```typescript
const content = sanitizeContent(params.content);
const tokenCount = estimateTokens(content);
const mergedTags = [...new Set([...(params.tags ?? []), ...extractKeywords(content)])];

// NEW: best-effort embedding generation
let embeddingJson: string | null = null;
try {
  const vec = await embedText(content);  // new client; see §7
  if (vec) embeddingJson = JSON.stringify(vec);
} catch { /* swallow — fallback path handles null */ }
```

**Embeddable text source:** `content` only (post-sanitization). Tags are noisy keyword extracts (see `extractKeywords` at line 62-67 — auto-derived from content), so `content + tags` would double-count the same lexical signal in the embedding. Use raw post-sanitize `content`.

**Note:** `remember()` is currently sync (`better-sqlite3` is sync). Adding `await embedText(...)` makes it async. Either (a) make `remember` async (cascades to all callers — large diff) or (b) write the row sync first, then run embedding generation in a background micro-task that UPDATEs `embedding_json` (lazy backfill, no caller change). Recommend (b) — minimizes blast radius. Same approach for `upsert` at line 360.

**Also embed in `upsert()`** (line 360-455) at the equivalent insertion point after sanitization (line 397).

---

## 7. LM Studio `/v1/embeddings` contract — no existing call

**Grep confirms:** no code in the repo currently hits `/v1/embeddings`. The only LM Studio caller is `auto-extract-runner.ts` (`/v1/models` probe + `/v1/chat/completions` POST). The embeddings endpoint must be a new client.

**Pattern to mirror from `auto-extract-runner.ts`:**
- `trimEndpoint()` helper (line 61-63)
- `probeLmStudio()` model-loaded check (line 91-137)
- `AbortController` + `setTimeout` timeout wrapping (line 226-228, 273)
- Never-throws contract: encode failures as status strings, return `null` for vector
- `temperature` / `top_p` NOT applicable to embeddings — strip from request body

**OpenAI-compatible `/v1/embeddings` request body:**
```json
{ "model": "<embedding-model-id>", "input": "<text>" }
```

**Response shape:**
```json
{ "data": [ { "embedding": [0.123, -0.456, ...], "index": 0 } ], "model": "...", "usage": {...} }
```

**Extract:** `response.data[0].embedding` → `number[]`.

**Env vars to define** (mirror existing convention):
- `LMSTUDIO_ENDPOINT` — already in use, reuse it.
- `RELAY_EMBEDDING_MODEL` — new, e.g. `nomic-embed-text-v1.5`. No default; if unset, skip embedding (treat as "feature off").

**Cosine sim** is a 5-line pure helper, lives in the engine (no I/O, pure math):
```typescript
export function cosineSim(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
```

Range: `[-1, 1]` mathematically; clamp to `[0, 1]` before passing as `semanticSimilarity` (embeddings from text models almost always sit `>= 0`, but be defensive: `Math.max(0, Math.min(1, sim))`).

---

## 8. Test patterns — 2 references

### Reference A: `src/memory/score-memory.test.ts` (lines 1-111)

- **Framework:** `node:test` + `node:assert/strict` (NOT Jest/Vitest).
- **Fixture helper:** `createMemory(overrides: Partial<Memory>)` (line 7-33) — builds a minimal `Memory` with sensible defaults; spread `...overrides` last. Adopt verbatim for `embedding_json` tests.
- **Assertion style:** comparative (`assert.ok(scoreA > scoreB, 'msg')`) rather than absolute values — robust to weight tuning. Use this for "memory with embedding scores higher than one without on synonym query".
- **No DB:** pure functions only. Engine tests never touch SQLite. Mirror this — pass `semanticSimilarity` directly as a number, do not stand up LM Studio in unit tests.

### Reference B: `src/memory/budgeted-recall.test.ts` (lines 1-149)

- **Helper `makeMemory`** (line 8-40) — same shape as A but inline in describe block.
- **Score-threshold edge cases** documented inline (line 42-69 explains exactly which combinations cross the 0.15 MIN_RELEVANCE_SCORE). Adopt this commenting style — when adding the semantic-fallback test, document why a specific `semanticSimilarity` value (e.g. `0.9`) flips a row from omitted → included.
- **Empty case** (line 141-148) — always include an empty-input test. For embeddings: empty `similarities` map should produce identical output to no map at all.

**New tests required:**
1. `scoreMemory` with `semanticSimilarity=0.9` and bag-of-words match=0 → contentscore equals 0.9, beats word-overlap-only memory. (Engine unit test, no DB.)
2. `scoreMemory` with `semanticSimilarity=undefined` and word-overlap match → behaves byte-identical to pre-change code. (Regression guard.)
3. `budgetedRecall` with partial `similarities` map (half rows have entries, half don't) → mixed corpus works. (Engine unit test.)
4. `embedText()` client unit test: mock fetch with OpenAI-shaped response → returns `number[]`. Mock fetch rejection → returns `null` (never throws). Mirror `auto-extract-runner.test.ts` mocking style.
5. Migration test: open in-memory DB without `embedding_json`, run `migrateMemoryTables`, assert PRAGMA shows new column. (Same shape as existing PRAGMA-guard migration tests if any — check `memory-store.ts` consumers.)

---

## 9. Order of operations (no code changes here, just sequence)

1. `types.ts` — add `embedding_json: string | null` to `MemoryRow`; add optional `embedding: readonly number[] | null` to `Memory`; map in `rowToMemory` (memory-store.ts:78-104).
2. `db-migrations.ts` — add PRAGMA-guarded ALTER (§2).
3. New file `src/memory/embedding-client.ts` — LM Studio `/v1/embeddings` wrapper following `auto-extract-runner.ts` patterns (§7).
4. `memory-engine.ts` — add `cosineSim`, extend `scoreMemoryDetailed`/`scoreMemory`/`budgetedRecall` signatures (§4).
5. `memory-store.ts::remember/upsert` — fire-and-forget embedding generation, lazy UPDATE (§6).
6. `memory-store.ts::getCandidates` — after FTS fetch, embed query once, gather row vectors, build `similarities` map, pass to engine.
7. Tests per §8.
8. Backfill command (optional, deferred): `relay memory embed-backfill` walks rows with `embedding_json IS NULL` and populates.

---

## 10. What this pattern explicitly does NOT do

- Does **not** add a vector index (sqlite-vec, faiss). Cosine is computed in JS over the FTS5-narrowed candidate set (≤500 rows per `getCandidates`).
- Does **not** change FTS5 behavior. FTS remains the primary candidate-narrowing mechanism; embeddings re-rank within that set.
- Does **not** block writes on LM Studio availability. Embeddings are best-effort; null is a valid steady state.
- Does **not** touch `consolidation.ts` in this slice (ROADMAP §5 "secondary benefit" — separate follow-up).
- Does **not** change any existing test's expected numeric output (the optional `opts` arg defaults to undefined → word-overlap path → identical result).
