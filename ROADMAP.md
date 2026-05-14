# Relay Roadmap

Working notes for v0.2 and beyond. Written to be self-contained: any CC session or contributor
can read this cold and understand what's planned, why, and where the code lives today.

Each section states the current state, the gap, and what the implementation would touch.

---

## Status key

- `[ ]` not started
- `[~]` partial / stubbed in code
- `[x]` done

---

## 1. Schema cleanup (prerequisite for v0.2)

**Current state**: `applySchema()` in `src/runtime/store/db.ts` is additive-only. All DDL uses
`IF NOT EXISTS`, all column additions use `PRAGMA table_info()` guards. There is no migration
version table and no `DROP TABLE` path. Tables that lost their CLI surface still exist in the
schema.

**Orphaned tables** (DDL present, zero active SQL reads/writes outside `db.ts`):

| Table | Notes |
|---|---|
| `continuity_objects` | Contract types in `src/contracts/continuity.ts` but no cmd-*.ts uses them |
| `recipes` | Zero references outside db.ts |
| `sign_offs` / `sign_off_amendments` | Immutability triggers present; `src/contracts/amend_sign_off.ts` schema exists but is never imported by any command |
| `operator_annotations` | Zero references outside db.ts |
| `proxy_requests` | Zero references outside db.ts |
| `jobs` / `tasks` / `task_deps` / `job_events` | Full lease-field DDL; `cmd-parallel.ts` uses a local `tasks` array from the JSON spec, not this table |
| `verifications` | Only touched by `purgeTaintedVerificationRecords()` DELETE on startup; nothing INSERTs into it |

**What to do**:
- Add a `schema_version` table with a single integer row
- Add versioned `DROP TABLE` migrations gated on version bump
- Drop the orphaned tables above in version 2

**Files to touch**: `src/runtime/store/db.ts`, `src/memory/db-migrations.ts`

---

## 2. Agentic local LLM runner

**Current state**: `src/workers/lmstudio.ts` is single-shot — one `POST /v1/chat/completions`,
one response, done. No `capabilities` flag declared (treated as non-agentic by default).
`src/workers/anthropic.ts:10` is explicitly `capabilities = { agentic: false }`. Only the
Codex runner declares `capabilities = { agentic: true, execution_model: "subprocess" }`
(`src/workers/codex.ts:651`) — it shells out to the Codex CLI which handles the loop.

**Gap**: To drive Figma, a terminal, or any tool-using task with a local model, you need an
agentic loop:
1. POST `/v1/chat/completions` with a `tools` array
2. If response contains `tool_calls`, execute them locally
3. Append `{ role: 'tool', content: result }` to messages
4. Loop until no `tool_calls` or max iterations reached

LM Studio already supports the OpenAI tool-calling API for models that have it (Llama 3.1,
Qwen 2.5, Mistral, etc.). The runner just doesn't use it.

**What to do**:
- Add `src/workers/lmstudio-agentic.ts` with `capabilities = { agentic: true }`
- Extend `WorkerTask` with an optional `tools` field (OpenAI tool definition format)
- Extend `WorkerResult` with `tool_call_count` and `iterations`
- Add max-iterations guard (suggested default: 20)
- Tool execution: two viable paths — (a) shell commands (same pattern as Codex),
  (b) registered in-process handlers. Decision deferred; shell commands are simpler to start.
- Keep the existing single-shot `lmstudio.ts` untouched — this is additive

**Files to touch**: `src/workers/lmstudio-agentic.ts` (new), `src/workers/types.ts`,
`src/cli/cmd-run.ts` (provider dispatch)

---

## 3. Figma integration via agentic local runner

**Current state**: `DISABLED_CODEX_MCP_LABELS = new Set(['figma', 'notion', 'pencil'])` in
`src/workers/codex.ts` — Figma was explicitly disabled for the Codex MCP path. No Figma
tooling exists for local models.

**What this unlocks**: A local LLM (no API cost, offline) that can create Figma components,
manage design tokens, and build layouts from plain English descriptions. relay's memory system
already handles the "train it on your design system" requirement — design tokens, naming
conventions, spacing rules stored as `fact` memories scoped to the project workdir, recalled
at session start via `relay context emit --target lmstudio-http`.

**What to do**:
- Implement the agentic runner (section 2) first
- Define a Figma tool set: `figma_create_component`, `figma_update_token`,
  `figma_get_selection`, `figma_list_layers` — each maps to a Figma REST API call
- Wire tools into the agentic runner's execution path
- Memory injection via `loadRecalledLessonsContent()` already works; no changes needed there

**Dependency**: Section 2 must ship first.

---

## 4. Conflict detection in memory recall

**Background**: The δ-mem paper (arXiv, 2025) introduces a delta-rule update for parametric
memory that computes an error signal when writing — `error = target - M · key` — quantifying
how much new information conflicts with stored information. relay has no equivalent.

**Current gap**: Two memories can directly contradict each other and both get recalled, scored
independently, and injected with equal standing. The model receives conflicting instructions
with no signal that a conflict exists.

Example failure: memory A says "use kebab-case for CSS classes," memory B says "prefer
camelCase for all identifiers." Both get recalled. Neither is flagged.

**What to do**:
- At write time in `MemoryStore.remember()`, run a conflict check against active memories
  for the same workdir: high tag overlap + low content similarity = candidate conflict
- Add `conflicts_with_json TEXT` column to `memories` (PRAGMA-guarded migration) storing
  `[memory_id, ...]` of conflicting entries
- In `budgetedRecall()` (`src/memory/memory-engine.ts:195`), after scoring, run a pairwise
  conflict pass: when two conflicting memories are both candidates, prefer the higher-trust one.
  Either drop the lower-trust one from the result or inject it with an explicit
  `⚠ CONFLICTS WITH #N:` annotation so the model knows
- Surface conflict signals in `relay memory why` output (already shows `ScoreComponents`)
- The pairwise pass requires changing `budgetedRecall` from per-memory independent scoring
  to a selection loop that is conflict-aware — architecturally new

**Files to touch**: `src/memory/memory-engine.ts`, `src/memory/memory-store.ts`,
`src/memory/db-migrations.ts`, `src/memory/types.ts`

---

## 5. Semantic scoring via local embeddings

**Current state**: `computeContentScore()` in `src/memory/memory-engine.ts:59` uses word-overlap
substring matching:

```typescript
const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
if (contentLower.includes(word)) matches++;
return matches / words.length;
```

This is bag-of-words. It misses synonyms, paraphrases, and any semantic relationship that
doesn't share surface tokens. A memory about "prefer kebab-case for CSS" scores zero against
a query about "naming conventions for stylesheets."

**What to do**:
- At write time, call LM Studio's `/v1/embeddings` endpoint to generate an embedding for
  each new memory. LM Studio is already the auto-extract backend — this is one additional
  request per `remember()` write.
- Add `embedding_json TEXT` column to `memories` (PRAGMA-guarded migration)
- At query time in `getCandidates()`, embed the query the same way, compute cosine similarity
  against stored embeddings, use as the `content` score component in `scoreMemoryDetailed()`
- The pure-function design of `memory-engine.ts` is preserved: pass the pre-computed
  similarity in as a parameter rather than computing it inside the scoring function
- Secondary benefit: cosine similarity on embeddings makes `consolidation.ts` near-duplicate
  detection much stronger — catches paraphrases that Jaccard on surface tokens misses

**Files to touch**: `src/memory/memory-engine.ts`, `src/memory/memory-store.ts`,
`src/memory/db-migrations.ts`, `src/memory/types.ts`

**Note**: Requires an embedding-capable model loaded in LM Studio. Falls back to word-overlap
if `embedding_json` is null (i.e., memory was written before this feature or without LM Studio
running).

---

## 6. Delta extraction in auto-extract

**Current state**: `cmd-memory-auto-extract.ts` loads a 32KB trailing transcript window and
asks LM Studio "what lessons are here?" It has no awareness of what relay already knows. This
causes re-extraction of known patterns, near-duplicate accumulation, and silent conflicts.

**Background**: δ-mem's core framing is differential — the delta rule writes the *difference*
between what's being learned and what's stored. Only the gap is written.

**What to do**:
- Before calling LM Studio in `auto-extract-runner.ts`, load current recalled memories for
  the workdir via `MemoryStore.getCandidates()`
- Pass them into the extraction prompt (T10 template):
  ```
  Existing known patterns:
  [recalled memories]

  New transcript:
  [session window]

  Extract only what the transcript ADDS, CONTRADICTS, or REFINES relative to what is
  already known. Flag contradictions explicitly. Do not re-extract known patterns.
  ```
- Contradictions surface as a new `memory_source` value or as entries with a
  `conflicts_with` reference, feeding directly into the conflict detection system (section 4)
- Extraction noise drops because re-extraction of known patterns is suppressed at the prompt level

**Files to touch**: `src/memory/auto-extract-runner.ts`, `src/memory/auto-extract-transcript.ts`
(to pass existing memories into the runner), and the T10 prompt template

---

## 7. Budget command (deferred from v0.1)

**Current state**: `relay budget show` is a stub that prints "deferred (target: 0.2.0)".
Comment in code: "BudgetStore needs per-provider scope."

**What to do**: Scope `budget_store` entries by provider + workdir. Surface via
`relay budget show [--provider <name>] [--workdir <path>] [--json]`.

**Files to touch**: `src/runtime/budget/budget-store.ts`, new `src/cli/cmd-budget-show.ts`

---

## Sequencing

```
1. Schema cleanup          — unblocks clean v0.2 baseline
2. Agentic local runner    — unblocks Figma and all tool-use workflows
3. Conflict detection      — highest-value memory improvement, self-contained
4. Semantic embeddings     — improves recall quality across everything
5. Delta extraction        — builds on conflict detection (sections 3+4)
6. Figma integration       — builds on agentic runner (section 2)
7. Budget command          — isolated, low risk, finishes deferred work
```
