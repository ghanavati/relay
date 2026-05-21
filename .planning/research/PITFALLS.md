# Pitfalls Research — Relay v0.2

**Domain:** Adding tool-calling loops, semantic memory, conflict detection, delta extraction, and Figma integration to an existing TypeScript local-first CLI (Relay v0.1.2, 972 tests passing, better-sqlite3, Node 20+, TDD)
**Researched:** 2026-05-18
**Confidence:** HIGH (grounded in `.planning/v0.2-improvised-scrap/` research + ROADMAP-DRIFT verification + prior codex wave-4 incidents)

> **Audience caveat.** Solo user is a designer/marketer with limited dev background. Pitfalls below favour **prevention over diagnosis** because the user cannot debug a half-broken integration mid-flight. "Fail fast and loud" beats "degrade silently" on every axis here.

---

## Feature 1 — Agentic Tool-Calling LM Studio Worker

### Pitfall 1.1: JSON Fence Drift / Pythonic Tool Calls

**What goes wrong:** LM Studio returns `finish_reason: "stop"` with `tool_calls: []` while the model's `content` field contains a Python list literal (LFM2 default) or a Markdown-fenced JSON object the parser missed. Runner thinks the model is done; in reality it just tried to call a tool. User sees garbled output, no tool ever ran.
**Why it happens:** LFM2 defaults to Pythonic call format unless the system prompt forces JSON. Qwen3-Coder 30B has a known bug (Issue #475) where `<tool_call>` tag is dropped after text. Gemma 4 on MLX has empty-tool_calls bug (mlx-lm #1096).
**Warning sign:** Agentic run completes in 1 iteration with `tool_call_count = 0` but the user asked for something that obviously requires a tool. `content` field contains substring matching `[\s*{` or `[{"`.
**Prevention:** (1) Hard-pin to `qwen/qwen3-coder-next` as default; this is the only model with verified clean JSON tool-call emission. (2) Pre-flight `GET /api/v0/models` and refuse to dispatch unless `capabilities: ["tool_use"]` is present. (3) Add system-prompt suffix `"Output function calls strictly as JSON in the tool_calls field, never as Python literals."` (4) Detect drift: if `content` contains `[\s*{|\bfunctioncall\b|<tool_call>` AND `tool_calls.length === 0`, log a `TOOL_CALL_DRIFT_DETECTED` warning and surface as a non-retryable error rather than silently treating as final answer.
**Phase to address:** Phase 2 (agentic runner) — must ship in the very first version of `src/workers/lmstudio-agentic.ts`. Drift detection is not a v0.3 polish item.

### Pitfall 1.2: Token Loop / Infinite Tool-Call Repetition

**What goes wrong:** Model gets confused, calls `figma_list_layers` with the same arguments 47 times in a row, burns 5 minutes of wall-clock and 200K tokens, then hits max-iterations and returns a useless error. User's machine fan spins up, LM Studio memory pressure spikes, OS may SIGKILL the LM Studio server.
**Why it happens:** Iteration cap alone catches slow loops but not fast ones. Even with `max_iterations = 20`, a tight loop wastes the entire budget. The LM-Studio research doc (Section "Error Modes") explicitly recommends a loop detector beyond the counter.
**Warning sign:** Same `(function.name, JSON.stringify(sortedArgs))` tuple appears 3 times in `tool_call_history`. Token usage from `response.usage` growing linearly per iteration with no progress signal.
**Prevention:** (1) Hash every tool call as `sha256(name + canonicalJsonStringify(args))` and store last 3 hashes per loop. Abort on 3 consecutive identical hashes with `LOOP_DETECTED` error. (2) Hard max-iterations default 20, **configurable** via `WorkerTask.maxIterations` (per AGENTIC-WORKER-PATTERN.md A4). (3) Wall-clock timeout via AbortController layered on top of iteration cap — both must exist (per AGENTIC-WORKER-PATTERN.md section 3). (4) Cumulative token watchdog: track `usage.total_tokens` per iteration, abort if approaching model context limit (default `qwen3-coder-next` is ~256K — abort at 80%).
**Phase to address:** Phase 2, MVP — never ship the agentic runner without all 3 guards (hash loop, iteration cap, token watchdog).

### Pitfall 1.3: Hidden System Prompt Pollution (GLM-4 Preset Drift)

**What goes wrong:** User loads `zai-org/glm-4.7-flash` via the model.yaml preset which silently injects a hidden "be helpful and thorough" system prompt at the top of every conversation. Our explicit system prompt (`"You are a tool-calling agent..."`) becomes message #2 instead of #1. Model ignores tool-use instructions and starts narrating instead of calling tools. Existing memory injection (`loadRecalledLessonsContent`) gets buried under the preset prompt.
**Why it happens:** This is exactly what the user's `feedback_lmstudio_routing.md` memory documents — LM Studio applies preset system prompts (`model.yaml`). Bypassing via raw curl loses the preset. Calling via SDK respects preset. Our HTTP client will pick up preset unless explicitly stripped.
**Warning sign:** Tool-call quality differs dramatically between LM Studio CLI invocation and our HTTP runner. Diff `/v1/chat/completions` request body in DEBUG mode and inspect what's actually being sent vs what arrives.
**Prevention:** (1) **Document loaded-preset assumption per model** in WORKERS-MAP.md and check `model.yaml` for any default `system_prompt:` field before adopting a new model. (2) Add `RELAY_LMSTUDIO_DEBUG_DUMP=1` env var that writes every request/response pair to `~/.relay/debug/lmstudio-NNNN.json` for postmortem. (3) Default to `qwen/qwen3-coder-next` which (per LMSTUDIO-TOOL-API.md, HIGH confidence) does not ship with a hidden preset. (4) Explicit `pre-flight` step: send a tiny ping request and dump full message echo to verify no preset injection.
**Phase to address:** Phase 2 (agentic runner) — add `--debug-dump` flag to `relay run` first; document in WORKERS-MAP.md.

### Pitfall 1.4: Tool Result `tool_call_id` Mismatch

**What goes wrong:** LM Studio uses arbitrary numeric strings (e.g., `"365174485"`) for `tool_calls[].id`, not OpenAI-style `call_*`. Worker normalizes IDs (lowercase, strip dashes, prefix-with-call_) thinking it's being defensive. Subsequent tool-result message has mismatched `tool_call_id`. LM Studio returns 400 with cryptic error or silently re-issues the original prompt — model loops because it never sees the tool result.
**Why it happens:** Defensive normalization is a common reflex but the OpenAI spec requires byte-exact echo of `tool_call_id` (per LMSTUDIO-TOOL-API.md "Critical field notes"). The IDs are opaque tokens, not semantic identifiers.
**Warning sign:** Tool execution succeeds (logs show success) but model behaves as if tool was never called. `tool_call_id` in outgoing tool message ≠ `tool_calls[i].id` in prior assistant message (visible in debug dump).
**Prevention:** (1) **Never transform `tool_call_id`** — treat as opaque. Echo byte-exact. (2) Add an assertion in the message-builder: `assert(toolMessage.tool_call_id === assistantMessage.tool_calls[i].id)`. (3) Test case: round-trip a numeric-only ID and a UUID-style ID through the worker and confirm both pass through unchanged.
**Phase to address:** Phase 2 (agentic runner) — failing test for this exact pattern is a Phase 2 task-zero.

### Pitfall 1.5: Streaming Accumulation Bugs (Defer Streaming Entirely)

**What goes wrong:** Team enables `stream: true` for "responsiveness." `function.arguments` arrives as JSON fragments across N chunks. Code parses incrementally, hits a parse error mid-stream, retries, gets a different fragment ordering due to v0.3.17+ token-by-token streaming. Tool calls fire with malformed args. Parallel tool calls (multiple `index` values) get merged into one because accumulation is by array position not by `index` field (v0.3.18 fixed this server-side but clients still get it wrong).
**Why it happens:** Streaming tool-call accumulation is non-trivial; the LMSTUDIO-TOOL-API.md research explicitly recommends `stream: false` for v0.2 first cut.
**Warning sign:** Intermittent malformed-args errors, parallel tool calls dropping silently, "works on local box, breaks in CI" because streaming chunk boundaries differ by network buffer size.
**Prevention:** Hard-code `stream: false` in `lmstudio-agentic.ts` v0.2. Add a `RELAY_LMSTUDIO_STREAM=1` env var ONLY for future opt-in, OFF by default. Document streaming as a v0.3 roadmap item, not a v0.2 polish.
**Phase to address:** Phase 2 (agentic runner) — set the default; don't ship streaming until v0.3 with explicit testing matrix.

---

## Feature 2 — Semantic Embeddings on Memory Store (nomic-embed-text-v1.5)

### Pitfall 2.1: Breaking memory-engine.ts Pure-Function Contract

**What goes wrong:** Naive implementation puts the `fetch('/v1/embeddings')` call inside `computeContentScore()`. Every recall becomes an HTTP roundtrip. `scoreMemoryDetailed()` becomes async. Every consumer of `scoreMemory()` (28 callers per memory-engine.test.ts) must be refactored. The "pure function" property the whole engine rests on dies. Tests that pass in-memory data start needing mocked fetchers. Hooks that call recall start timing out because they're waiting on LM Studio.
**Why it happens:** "Just put the embedding call where the score is computed" is the obvious first instinct. EMBEDDING-PATTERN.md explicitly warns against this.
**Warning sign:** `computeContentScore` signature gains `async` or new `embedClient` parameter. `memory-engine.test.ts` requires HTTP mocking. Recall latency rises from <5ms to >100ms.
**Prevention:** (1) **Embeddings are computed at write time in `MemoryStore.remember()`**, stored as `embedding_json TEXT` column in the memories table. (2) **Query embedding is computed in `MemoryStore.getCandidates()`** (the impure layer that already does SQL), then **passed as a pre-computed parameter** into the pure scorer. (3) Pure scorer signature becomes `computeContentScore(content, query, precomputedCosineSimilarity?)` — falls back to word-overlap if similarity not provided. (4) Test: assert `memory-engine.ts` imports zero from `node:http`, `node-fetch`, or `src/runtime/http`.
**Phase to address:** Phase 4 (semantic embeddings) — write the failing import-restriction test FIRST.

### Pitfall 2.2: Backward Compat — Old Memories Have No Embedding

**What goes wrong:** Migration runs, adds `embedding_json` column with NULL default. All 1000 existing memories now have `embedding_json IS NULL`. Recall logic does `cos(queryEmb, JSON.parse(row.embedding_json))` — throws on every old row. User's recall pipeline goes from "works" to "throws TypeError" in a single migration. v0.1.2 → v0.2 upgrade looks like a data loss event.
**Why it happens:** Migrations that add a column rarely backfill data. Code paths that read the column assume it's populated. PRAGMA-guarded ALTER passes the test suite (fresh DB), production blows up.
**Warning sign:** Migration test uses fresh DB only. No upgrade-from-v0.1.2 test fixture exists. Code uses `JSON.parse(row.embedding_json)` without null check.
**Prevention:** (1) **Mandatory upgrade-fixture test:** Check in a v0.1.2-era DB at `src/memory/__fixtures__/v0.1.2-memories.db` (anonymized, ~5 rows). Test that opening this DB, running migrations, and calling `recall("test")` works without errors. (2) Score function falls back to word-overlap when `embedding_json IS NULL` (EMBEDDING-PATTERN.md note). (3) **Backfill is opt-in, not automatic** — `relay memory rebuild-embeddings --dry-run` first, then `--apply`. (4) Doctor check: `relay doctor` reports `embedding_coverage: 47/100 memories` so user sees the gap.
**Phase to address:** Phase 1 (schema cleanup) for the fixture-checkin, Phase 4 (embeddings) for the rebuild command.

### Pitfall 2.3: Embedding Dimension Mismatch / Model Swap

**What goes wrong:** User writes 500 memories with `nomic-embed-text-v1.5` (768-dim). Later switches default to `nomic-embed-text-v2-moe` (768-dim but different vector space) or `bge-large-en-v1.5` (1024-dim). New query embedding is 1024-dim, stored embeddings are 768-dim. Cosine similarity throws `length mismatch` OR (worse) silently returns garbage because some implementations zero-pad. Recall quality cliffs to zero, user has no idea why.
**Why it happens:** Embedding models are not interchangeable. Vector spaces are model-specific. Dimensions differ.
**Warning sign:** Recall results suddenly become irrelevant after model swap. `cosine(a, b)` produces consistently near-zero values. No error, just bad output.
**Prevention:** (1) Store `embedding_model TEXT` column alongside `embedding_json TEXT`. Refuse to compare across models (return word-overlap fallback for mismatched rows). (2) At startup, doctor check verifies `LM_STUDIO_EMBED_MODEL` env matches a sample of stored `embedding_model` values. Warn if mismatch. (3) `nomic-embed-text-v1.5` is the **only** supported v0.2 embed model — document it as such in NOMIC-EMBED-SPECS.md and refuse other models in the embedding client. (4) `relay memory rebuild-embeddings --model nomic-embed-text-v1.5` is the only blessed upgrade path.
**Phase to address:** Phase 4 (embeddings) — schema and doctor check must ship together.

### Pitfall 2.4: LM Studio Embeddings Endpoint Not Loaded — Silent Fallback Loop

**What goes wrong:** `relay memory remember` calls `/v1/embeddings`. LM Studio returns 404 because the embed model isn't loaded. Worker silently falls back to writing `embedding_json: NULL` (because that's our designed degraded path). Days later, user runs `relay memory recall` and notices results are bad. Investigates, finds 80% of recent memories have `embedding_json IS NULL`. Has to rebuild.
**Why it happens:** "Graceful degradation" can become "silent failure" when the user is not technical enough to notice the symptom. Designer/marketer users don't inspect SQLite rows.
**Warning sign:** Recall quality regression with no error logs. `embedding_json IS NULL` rate climbing in `relay info` over time.
**Prevention:** (1) **Loud fallback, not silent.** When the embedding endpoint is unavailable and a write proceeds with NULL embedding, **log to stderr** with a clear marker: `RELAY: embedding skipped (LM Studio /v1/embeddings returned 404). Run 'relay doctor' to check.` (2) Doctor adds an **embedding-service** check: probes `/v1/embeddings` with a tiny test string at startup, reports green/yellow/red. (3) `relay info` shows `embedding_coverage_24h: 12/15 writes embedded` — a visible drift signal. (4) Optional strict mode: `RELAY_REQUIRE_EMBEDDINGS=1` makes write fail loudly instead of degrading.
**Phase to address:** Phase 4 (embeddings) — doctor check is part of feature scope, not a follow-up.

### Pitfall 2.5: Cosine on Unnormalized Vectors / Manhattan Distance Confusion

**What goes wrong:** Implementer reaches for "similarity" function, accidentally writes Manhattan or Euclidean distance, or forgets to L2-normalize before dot-product. Results are mathematically valid scores in [0,N] range but ranking is wildly different from cosine. Memories that should rank near-top instead rank near-bottom.
**Why it happens:** Embedding libraries don't always normalize by default. nomic-embed-text-v1.5 output is **already L2-normalized** per the model card, but `nomic-embed-text-v2` is not. Easy to copy-paste the wrong formula.
**Warning sign:** Manual `relay memory why` shows content scores in unexpected ranges (>1.0 for cosine, or negative). Synonym test ("CSS classes" vs "stylesheet naming") still misses.
**Prevention:** (1) Add a small `src/memory/embedding-similarity.ts` with a single exported `cosine(a: number[], b: number[]): number` function. (2) **Test against a known fixture**: `cosine([1,0,0], [1,0,0]) === 1.0`, `cosine([1,0,0], [0,1,0]) === 0.0`, `cosine([1,0,0], [-1,0,0]) === -1.0`. (3) Always L2-normalize on read (defensive — cheap operation, ~7 multiplies for 768-dim). (4) Score is clamped to `[0, 1]` via `Math.max(0, cosine)` before being passed to the engine (negative cosine = "anti-related" which we treat as "unrelated", not "negative score").
**Phase to address:** Phase 4 (embeddings) — fixture-based test is the very first commit.

---

## Feature 3 — Conflict Detection in Memory Recall (δ-mem inspired)

### Pitfall 3.1: O(N²) Pairwise Scan on Every Recall

**What goes wrong:** Naive implementation: for each of K recalled candidates, compare to each of N memories in store (or each of K other candidates). At K=100 candidates and N=10K memories, that's 1M comparisons per recall. Recall latency goes from <5ms to >500ms. Hooks that trigger recall start blowing the 60s session-end window.
**Why it happens:** "Conflict detection" sounds cheap until you remember that "high tag overlap + low content similarity" requires actually computing both for many pairs.
**Warning sign:** `relay memory recall --benchmark` shows >100ms p95 latency. `relay info` shows session-end hook timing out.
**Prevention:** (1) **Conflict detection happens at WRITE time, not recall time.** Per DELTA-MEM-CONFLICT.md mapping: when `remember()` is called, query `memories WHERE tag-overlap > threshold AND workdir = ?` (cheap, indexed), compute content divergence against just those candidates (typically <10), store `conflicts_with_json: [id1, id2]` on the new row reciprocally. (2) **At recall time, conflict pass is just a JSON column read** — `O(K)` not `O(K²)`. (3) Tag-overlap query uses `tags_idx` (already-indexed) — add a covering index on `(workdir, tags_json)` if benchmarks demand. (4) Hard cap: never compare against more than 50 candidates at write time; if more match, sample.
**Phase to address:** Phase 3 (conflict detection) — performance budget is in the spec; failing benchmark is the test gate.

### Pitfall 3.2: Bidirectional Conflict Reference Becomes Stale

**What goes wrong:** Memory A says `conflicts_with: [B]`. User deletes B (or `superseded_by` chains B out). A still references B. Recall pass dereferences `conflicts_with`, gets phantom IDs, throws or silently skips. User sees inconsistent conflict warnings.
**Why it happens:** A-MEM lesson (per DELTA-MEM-CONFLICT.md): conflicts should be reciprocal. Reciprocal references are stale-prone in row-based stores.
**Warning sign:** `relay memory why <id>` shows conflict warning pointing to non-existent memory ID. Recall throws `Cannot find memory <id>` from the conflict-resolution code path.
**Prevention:** (1) **Conflicts_with references are advisory, never load-bearing.** Recall code does `LEFT JOIN` (or in JS, `.filter(m => m != null)`) — missing referents are silently dropped. (2) Add a periodic `relay memory consolidate --conflicts` pass that cleans stale references (runs as part of existing consolidation, opt-in). (3) When supersede() is called, **also** update conflict references on memories that pointed to the superseded one — transactional. (4) Test: write A conflicting with B, supersede B, recall A → no error, conflict annotation simply absent.
**Phase to address:** Phase 3 (conflict detection) — supersession+conflict interaction needs a dedicated test.

### Pitfall 3.3: Selection Loop Changes Engine Semantics

**What goes wrong:** ROADMAP §4 explicitly says: *"The pairwise pass requires changing `budgetedRecall` from per-memory independent scoring to a selection loop that is conflict-aware — architecturally new."* Implementer adds the loop without separating concerns. Now `scoreMemory()` and `budgetedRecall()` are intertwined. Tests that mocked one need to mock both. The pure-function property of the scorer breaks.
**Why it happens:** Refactoring `budgetedRecall` from `O(N) map+sort` to `O(N) score + selection loop` is a real architecture change. Easy to merge scoring and selection into one function.
**Warning sign:** `scoreMemory` gains a `candidatePool` or `siblings` parameter. Test file grows by >2x. Mock surface area increases.
**Prevention:** (1) **Two-pass architecture**: pass 1 = score every candidate independently (unchanged, still pure). Pass 2 = walk scored list, drop or annotate based on `conflicts_with`. These are two functions in two files: `scoreCandidates()` (pure, unchanged) and `resolveConflicts(scored)` (new, also pure — takes scored list, returns filtered/annotated list). (2) `budgetedRecall = score → resolveConflicts → packToBudget`. (3) Test: `resolveConflicts` operates on plain data, no DB access, no fetch.
**Phase to address:** Phase 3 (conflict detection) — architecture sketch reviewed before any code.

### Pitfall 3.4: "Annotate vs Drop" Decision Made at Wrong Layer

**What goes wrong:** Implementer hardcodes "drop lower-trust on conflict" inside `resolveConflicts()`. User wants the model to see conflicts ("annotate, don't drop") because their use case is debugging. Now there's no way to get conflicts surfaced in the recall output. Or vice versa.
**Why it happens:** ROADMAP §4 explicitly lists both behaviors as options: *"Either drop the lower-trust one from the result or inject it with an explicit `⚠ CONFLICTS WITH #N:` annotation."* Picking one without a config flag prematurely commits.
**Warning sign:** `resolveConflicts()` has no parameters controlling behavior. There's no config / env / CLI flag for "show conflicts inline."
**Prevention:** (1) **Default = annotate** (per Letta/A-MEM precedent — don't auto-delete). (2) Configurable via `RecallOptions.conflictPolicy: 'annotate' | 'drop-lower-trust' | 'drop-all-conflicts'`. (3) `relay memory recall --conflict-policy <X>` CLI flag, with stable default. (4) `relay memory why` always shows ALL conflict annotations regardless of recall policy — `why` is the debug surface.
**Phase to address:** Phase 3 (conflict detection) — config plumbing in v1, not a v0.3 retrofit.

### Pitfall 3.5: Conflict Detection Burns Budget on Trivial Variations

**What goes wrong:** Two memories both tagged `["css", "naming"]`. Content A: "Use kebab-case for CSS classes." Content B: "Always use kebab-case for class names in CSS files." High tag overlap + similar content = NOT a conflict (they agree). Naive divergence metric (Jaccard on tokens) flags them as conflict because Jaccard is sensitive to phrasing. User gets spurious conflict warnings on near-duplicates that should consolidate, not conflict.
**Why it happens:** The DELTA-MEM-CONFLICT.md analog mapping says "high tag overlap + LOW content overlap = conflict." But "low content overlap" via Jaccard is sensitive to phrasing variations. True semantic divergence requires embeddings.
**Warning sign:** Conflict count rises sharply after enabling feature on a workdir with consolidated memories. Most flagged "conflicts" are paraphrases.
**Prevention:** (1) **Phase ordering matters**: conflict detection (Phase 3) before semantic embeddings (Phase 4) means initial divergence metric must be conservative. Use a high Jaccard-distance threshold (>0.7 distance = "different enough to maybe conflict"). (2) When Phase 4 lands, upgrade divergence to `1 - cos(emb_A, emb_B)` per DELTA-MEM-CONFLICT.md §2. (3) Add `relay memory why` output for conflicts showing the divergence score so user can debug false positives. (4) Document phase-1 conflict detection as "noisy without embeddings" in CHANGELOG.
**Phase to address:** Phase 3 (conflict detection) with conservative threshold; Phase 4 (embeddings) upgrades to cosine.

---

## Feature 4 — Delta Extraction in Auto-Extract

### Pitfall 4.1: Existing-Memory Injection Blows Past LM Studio Context Window

**What goes wrong:** Delta extraction loads recalled memories and prepends them to the 32KB transcript window. Workdir has 500 memories. Even after budget-recall, 50 memories at ~100 tokens each = 5KB. Plus 32KB transcript. Plus T10 template. Total prompt = 40KB. `qwen3-coder-next` 256K context handles it, but a smaller fallback model (e.g., `lfm2-24b-a2b` at 8K) silently truncates the most-recent transcript bytes — the very content we wanted to extract from.
**Why it happens:** Per ROADMAP §6 plan: inject recalled memories into T10 prompt. Doesn't bound the injection. Truncation happens server-side, often silently.
**Warning sign:** Auto-extracted lessons start to be irrelevant or repetitive (because the truncation dropped the *new* content and kept the *existing* lessons). Extraction quality regression after delta extraction ships.
**Prevention:** (1) **Apply existing `budgetedRecall` to recalled-memory injection too.** Pass a `maxInjectionTokens` budget (default 4KB), let the existing scorer pick the most-relevant existing memories. (2) Pre-flight check: `(injectionTokens + transcriptTokens + templateTokens) < model.contextLimit * 0.8` — abort with `EXTRACT_PROMPT_TOO_LARGE` if not. (3) Doctor: report extraction model's context window so user sees the constraint. (4) Test: write a fixture with 1000 memories, run delta extraction, assert prompt size < 80% of context.
**Phase to address:** Phase 5 (delta extraction) — size budget enforced in `auto-extract-runner.ts`.

### Pitfall 4.2: Re-Extraction Suppression Eats Genuine Repeats

**What goes wrong:** Delta extraction prompt says "do not re-extract known patterns." User has a memory "always run tests before commit." User repeatedly forgets and gets reminded by Claude in 4 different sessions. The repetition is signal — it means the lesson didn't stick or the workflow makes it hard. Delta extraction suppresses every repeat. Recall quality stagnates because high-frequency reminders never get their `recall_count` bumped.
**Why it happens:** ROADMAP §6 framing is "extract only what ADDS, CONTRADICTS, or REFINES." Pure delta semantics. Misses the role of frequency in importance scoring.
**Warning sign:** `recall_count` on auto-extracted memories never increases despite the topic recurring. `relay memory recent --days 30` shows few entries on topics that came up frequently.
**Prevention:** (1) **Repeats are not extracted as new entries but DO bump `accessed_at` and `recall_count` on the matching existing memory.** This is a separate code path from extraction: in the runner, before sending to LM Studio, run a cheap match against existing memories; if `transcript_excerpt ~= existing_memory.content`, increment recall stats. (2) LM Studio extraction prompt only handles novel/contradicting content. (3) Test: ingest a transcript where 60% repeats existing memories — assert recall_count bumps on those, no new entries created for repeats, new entries for the 40% novel content.
**Phase to address:** Phase 5 (delta extraction) — bump-without-extract is part of the feature, not a follow-up.

### Pitfall 4.3: Hook Blocks CC When LM Studio Slow / Down

**What goes wrong:** Delta extraction calls LM Studio twice: once to embed for recalled memories, once for the extraction itself. LM Studio is slow (60s for cold-start embedding generation). SessionEnd hook waits. Claude Code closes the session and shows the user a "hook timeout" warning. User stops trusting Relay.
**Why it happens:** Hooks must never block CC (PROJECT.md Key Decision: *"Hooks must never block CC — every error path returns exit 0"*). Hook timeout is a real CC-side constraint, not a Relay-side aspiration.
**Warning sign:** Session-end hook duration exceeds 10s on slow extractions. CC shows "hook may be stuck" messages.
**Prevention:** (1) **Auto-extract dispatch is async / detached** — hook writes a `pending-extraction-NNNN.json` envelope to `.relay/queue/`, returns exit 0 immediately. (2) A separate `relay extract --process-queue` command (cron or next CC session triggers it) actually does the LM Studio work. (3) Hook timeout: wrap the queue write itself in `setTimeout(() => process.exit(0), 5000)` — if even the write fails, exit clean. (4) Test: simulate LM Studio returning 30s-delayed response, confirm hook still returns within 5s with `skipped:extract-queued` status.
**Phase to address:** Phase 5 (delta extraction) — queue/detach pattern is core, not optional.

### Pitfall 4.4: Contradiction Tag Floods the Memory Store

**What goes wrong:** Per ROADMAP §6: "Contradictions surface as a new `memory_source` value or as entries with a `conflicts_with` reference." Implementer interprets this as "store every contradiction as a new memory tagged `contradiction`." Workdir accumulates dozens of contradiction-typed memories. Recall starts returning conflicts about conflicts. User confused.
**Why it happens:** Delta extraction can output many micro-deltas per session. Each one written as a memory inflates the store.
**Warning sign:** Memory count grows >2x faster after delta extraction enabled. Recall results contain meta-conflicts ("this conflict supersedes that conflict").
**Prevention:** (1) **Contradiction is a relationship, not an entity.** When delta extraction identifies a contradiction, it writes the **new** memory and sets `conflicts_with_json: [existing_id]` — NOT a separate contradiction-entity. (2) Trust tier for contradicting auto-extracted memories defaults to `unverified` AND requires explicit confirmation before pin (already the default per PROJECT.md Key Decision). (3) Cap auto-extracted entries per session at 5 (existing pattern); contradictions count against this cap.
**Phase to address:** Phase 5 (delta extraction) — schema decision before code.

### Pitfall 4.5: Berry Hallucination Gate Skipped for Delta Output

**What goes wrong:** Delta extraction generates novel claims about "what the transcript adds." LM Studio gets creative, asserts things the transcript doesn't say. Existing pipeline (PRIV-06) requires Berry hallucination check for auto-extracted lessons. Implementer thinks "delta is different, it has the transcript context, the model won't hallucinate." Skips Berry gate. Hallucinated memories get auto-pinned over time via `recall_count` bumps.
**Why it happens:** False confidence — delta extraction *seems* grounded because it has more context. In practice it has MORE room to hallucinate because it must reason about the relationship between transcript and existing memories.
**Warning sign:** `mcp__berry__detect_hallucination` never called from delta-extraction code path. Memories created with `memory_source: 'delta-extract'` accumulate without verification.
**Prevention:** (1) **Berry hallucination gate is mandatory for ALL auto-extracted entries**, including delta. The gate lives in `auto-extract-runner.ts` after LM Studio output, before `MemoryStore.remember()`. (2) When Berry unavailable, fall back to `trust_level: 'unverified'` and shorten TTL to 7 days (vs the standard 30). (3) Test: delta extraction → Berry returns "flagged" → memory NOT written, logged with reason.
**Phase to address:** Phase 5 (delta extraction) — preserve PRIV-06 invariant.

---

## Feature 5 — Figma Integration (4 tools: 2 REST, 2 Plugin-API-via-Bridge)

### Pitfall 5.1: Silent Failure on Bridge Unavailable

**What goes wrong:** User asks "create a button component named Primary." Model calls `figma_create_component`. Figma Desktop not running, no bridge plugin. Implementer's "graceful degradation" returns `{success: true, message: "component creation queued"}`. Model tells user "Done!" User opens Figma, no component. Trust destroyed.
**Why it happens:** Engineers reflexively make failures "soft" to avoid breaking the flow. FIGMA-API-TOOLS.md (Section "Fallback if bridge unavailable") explicitly warns: *"Do not silently succeed — silent fallback corrupts the agent's world model."*
**Warning sign:** Tool result content contains `success: true` when bridge is down. Model's user-facing summary says "created" when nothing was created.
**Prevention:** (1) **Hard error on bridge unavailable.** Tool result is `{"error": "BRIDGE_UNAVAILABLE", "message": "Figma Desktop with Relay Bridge plugin must be running. See: relay doctor --figma."}` (2) Model is system-prompted to surface errors verbatim to the user, not retry-loop or fabricate success. (3) `relay doctor --figma` checks: (a) Figma Desktop process running, (b) WS bridge listening on 9223-9232, (c) PAT env var set, (d) sample REST call succeeds. (4) Test: tool dispatch with bridge down returns `BRIDGE_UNAVAILABLE` typed error, not success.
**Phase to address:** Phase 6 (Figma) — doctor check ships with the first Figma tool.

### Pitfall 5.2: Enterprise-Plan Wall on `figma_update_token`

**What goes wrong:** Per FIGMA-API-TOOLS.md (HIGH confidence): `POST /v1/files/{key}/variables` requires **Enterprise plan, full-seat member or admin, edit access on file**. User is on Pro plan. Tool dispatch returns 403. Model interprets 403 as "auth issue," prompts user to re-paste their token. User pastes new token, same 403. Loop.
**Why it happens:** 403 is ambiguous. Could be expired token, could be plan tier, could be wrong scope on token, could be file permissions.
**Warning sign:** User reports "I keep refreshing my Figma token and it keeps failing." Logs show 403s on `/variables` endpoint with valid PAT.
**Prevention:** (1) **Pre-flight plan check** before exposing `figma_update_token` to the model: call `GET /v1/me` (or a known-Enterprise-only endpoint), if response indicates not-Enterprise, **remove this tool from the tools array** for this user. Model never sees it as an option. (2) `relay doctor --figma` reports plan tier explicitly: `figma_plan: pro (variables write disabled — requires Enterprise)`. (3) When 403 IS returned, parse the response body for specific Figma error messages and map to clear messages: `PLAN_REQUIRED`, `TOKEN_EXPIRED`, `SCOPE_MISSING`, `FILE_NO_EDIT_ACCESS`. Each gets a different user-facing prompt.
**Phase to address:** Phase 6 (Figma) — plan detection in initial implementation.

### Pitfall 5.3: WS Bridge Port Scan Race Condition

**What goes wrong:** FIGMA-API-TOOLS.md recommends port range 9223-9232 (port-scan fallback). Implementer connects to first responding port. Another app (or a stale bridge from a prior session) listens on 9223. Relay connects, sends `figma.createComponent`. Other app responds garbled. Or worse, dev tool listens on 9224 and echoes commands; bridge listens on 9225 and never gets the command; user sees "success" from echo but nothing happens in Figma.
**Why it happens:** Port-scan fallback assumes the first respondent is the real bridge. No handshake.
**Warning sign:** "Component creation" succeeds but no component exists in Figma. Bridge connection inconsistent across machines.
**Prevention:** (1) **Handshake before commands**: bridge sends `{"server": "relay-bridge", "version": "0.2.0", "figma_file_key": "<key>"}` immediately on connect. Client validates `server === "relay-bridge"` before sending any command. (2) On invalid handshake, close connection, try next port. (3) Document bridge starts on 9223 only — fallback range is anti-conflict, not anti-failure. (4) Test: mock a non-bridge server on 9223, verify client rejects and tries 9224.
**Phase to address:** Phase 6 (Figma) — handshake in bridge protocol v1.

### Pitfall 5.4: REST Rate Limits Cascade Into Agentic Loop

**What goes wrong:** Per FIGMA-API-TOOLS.md: GET file/nodes is Tier 1 (10-20/min). Agent loop fires 5 `figma_list_layers` calls in quick succession during exploration. Hits 429. Tool returns rate-limit error. Model "thinks creatively" — calls `figma_list_layers` again with slightly different args to "work around." Burns more quota. Eventually account is locked or backoff goes exponential.
**Why it happens:** Rate-limit errors look like normal tool failures to the model. Model is trained to retry.
**Warning sign:** Multiple 429s in single agentic loop. Cumulative Figma API call count >10 per task.
**Prevention:** (1) **Rate-limit awareness in the tool wrapper, not the model.** When 429 received, read `Retry-After`, **sleep in the tool**, retry once, return success or hard-error after one retry. Model never sees the 429. (2) Per-loop API call cap: max 8 REST calls per agentic loop, hard-error after that with `RATE_BUDGET_EXCEEDED` (non-retryable). (3) Log rate-limit metrics to `relay info`: `figma_api_calls_24h: 47/300`. (4) Test: mock 429 with `Retry-After: 2`, verify tool sleeps 2s and retries.
**Phase to address:** Phase 6 (Figma) — rate-limit wrapper in shared REST client.

### Pitfall 5.5: Figma PAT Stored Insecurely / Leaked in Logs

**What goes wrong:** User pastes `FIGMA_API_TOKEN` into `.env` file. `.env` committed to git (no `.gitignore` entry for it). Or worse: agentic loop logs full HTTP request to stderr for debugging; `X-Figma-Token: figd_xxxxxx` appears in `~/.relay/debug/` logs. Token leaks to GitHub or to other apps that read user logs.
**Why it happens:** Designer/marketer user doesn't know about gitignore patterns. Debug logging is added casually during development.
**Warning sign:** `grep -r "figd_" ~/.relay/` returns matches. `.env` file present in `git status`.
**Prevention:** (1) **Doctor check**: `relay doctor --figma` warns if `FIGMA_API_TOKEN` is set in a file that's not in `.gitignore`. (2) **HTTP debug dump scrubs tokens**: anywhere we log requests, regex-replace `X-Figma-Token: \S+` → `X-Figma-Token: figd_***SCRUBBED***`. Same pattern as PRIV-05 (PII redaction). (3) `relay setup --figma` walks user through PAT creation, writes to a `~/.relay/secrets/figma.token` file with `chmod 600`, NOT to `.env`. (4) Test: enable debug dump, make a Figma call, grep dump file for raw token — assert no match.
**Phase to address:** Phase 6 (Figma) — secret scrubbing in HTTP client BEFORE any Figma code lands.

---

## Cross-Cutting Pitfalls (Span Multiple Features)

### CC.1: Backward Compatibility — v0.1.2 DB Upgrade Breaks Recall

**What goes wrong:** Schema cleanup (Phase 1) drops 11 orphan tables. Migration assumes additive-only history. Existing v0.1.2 DB has rows in dropped tables (continuity_objects, recipes, etc.). DROP TABLE succeeds but downstream code that reads `superseded_by` or `entity_key` from memories table breaks because PRAGMA-guarded ALTERs in the migration may not run in the right order on an old DB. User loses recall.
**Why it happens:** Migration testing only covers fresh-DB. Upgrade-path testing is forgotten. Relay's history (codex wave-4 audit) shows this is a real risk pattern.
**Warning sign:** No `__fixtures__/v0.1.2.db` exists in repo. CI doesn't run migrations against a real v0.1.2 DB.
**Prevention:** (1) **Mandatory test fixture**: check in `src/memory/__fixtures__/v0.1.2-baseline.db` (anonymized) with representative rows. (2) Migration test asserts: open fixture → apply all migrations → recall returns expected results → no errors. (3) `relay setup --upgrade` command for explicit user-driven upgrade with backup-first (writes `~/.relay/backup-pre-v0.2.db` before any migration). (4) DROP TABLE wrapped in `BEGIN TRANSACTION ... COMMIT` with rollback on any error.
**Phase to address:** Phase 1 (schema cleanup) — fixture is the first commit.

### CC.2: Hook Exit-0 Discipline Erodes

**What goes wrong:** PROJECT.md Key Decision says: *"Hooks must never block CC — every error path returns exit 0 with typed `skipped:*` status."* New features add new error paths. Delta extraction throws (LM Studio down). Agentic runner throws (model not loaded). Without explicit `exit 0` in every catch block, hook returns non-zero. CC sees the failure, shows the user a "hook failed" warning, may disable the hook entirely.
**Why it happens:** Defensive error handling habit says "throw and let the caller decide." For hooks, the caller IS the OS, and non-zero exit kills the integration.
**Warning sign:** Hook command code contains `throw new Error(...)` without surrounding `try/catch → process.exit(0)`. Test for "hook returns exit 0 on internal failure" missing for new features.
**Prevention:** (1) **All cmd-*-hook.ts entrypoints wrap their body in a top-level `try { ... } catch { ... process.exit(0); }`.** (2) Test pattern: for every hook command, write a test that simulates internal failure (e.g., DB write error, LM Studio 500) and asserts `process.exitCode === 0`. (3) Lint rule (or grep-based CI check): forbid `throw` in any function whose name ends with `Hook` or whose file matches `cmd-*-hook.ts`. (4) Hook output uses `skipped:lmstudio-unavailable`, `skipped:embedding-timeout`, etc. — structured signal, exit 0.
**Phase to address:** Cross-cutting — enforce in CI for Phase 2, 4, 5 (any feature touching hooks).

### CC.3: Workdir Scoping Leak — Cross-Workdir Memory Contamination

**What goes wrong:** New features (embeddings, conflict detection, delta extraction) add new SQL queries against `memories` table. One of them forgets the `WHERE workdir = ?` clause. Or uses `workdir IS NULL OR workdir = ?` when it should be strict-equal. User's work memories leak into personal workdir recall results.
**Why it happens:** `assertWorkdirAllowed` is called at the entry points (memory-store.ts:288, 375) but new SQL added in new files may not be routed through those checkpoints. Codex wave-4 audit found multiple WORKDIR scoping bugs (P1 findings).
**Warning sign:** New `SELECT ... FROM memories` queries in new files (e.g., `conflict-detector.ts`, `embedding-service.ts`) without explicit workdir parameter. Recall in workdir A returns content from workdir B.
**Prevention:** (1) **All `SELECT/UPDATE/DELETE FROM memories` MUST go through `MemoryStore` methods**, never raw SQL in feature modules. (2) `MemoryStore` interface adds typed `WorkdirScopedQuery` parameter — TypeScript compile error if workdir omitted. (3) Test pattern: for every new feature, write a cross-workdir contamination test: write memory in workdir-A, query/extract/embed in workdir-B, assert workdir-A memory is NEVER returned. (4) Grep CI check: any `FROM memories` outside `src/memory/memory-store.ts` is flagged for review.
**Phase to address:** Cross-cutting — test pattern enforced from Phase 3 onward.

### CC.4: memory-engine.ts Pure-Function Contract Erodes

**What goes wrong:** Embeddings add HTTP. Conflict detection adds DB lookup. Both tempted to put IO inside `scoreMemoryDetailed()` or `budgetedRecall()`. The pure-function property dies. Tests need mocking. Hooks get slow. Codex wave-4 P1 found a similar pattern in `consolidation.ts` previously.
**Why it happens:** "Cohesion" instinct: put the logic where the data is used. Wrong for pure functions.
**Warning sign:** Imports in `memory-engine.ts` grow beyond `./types`. Functions become `async`. Test setup grows by 10+ lines per test.
**Prevention:** (1) **Lint rule / CI check**: `src/memory/memory-engine.ts` MAY ONLY import from `./types`, `./constants`. Forbidden: any DB, HTTP, fs, child_process, node:* runtime import. (2) Pre-compute everything in `MemoryStore` (impure boundary), pass primitives into engine. (3) Test: `grep -n "import" src/memory/memory-engine.ts` outputs only allowed imports. (4) Periodic architecture review checkpoint at each phase: "did this phase change memory-engine.ts imports?"
**Phase to address:** Cross-cutting — CI lint check is Phase 1 work, enforced thereafter.

### CC.5: LM Studio JSON Fence Drift / Token Loops (See 1.1, 1.2)

(Covered in Feature 1 pitfalls 1.1 and 1.2. Surfaced here as cross-cutting because **the same model produces output for both agentic runner AND delta extraction AND embedding generation** — drift in any of these poisons the others.)

**Cross-cutting prevention:** Every feature using LM Studio MUST (1) pin to a specific model verified for that task, (2) probe `/api/v0/models` for capability before dispatch, (3) implement a model-output sanity check (JSON-shape assertion, drift detection, etc.) BEFORE consuming the output. Standard pattern in a single `src/runtime/lmstudio/output-guard.ts` helper.

### CC.6: Silent Service-Unavailable Failures (Berry, nomic, qwen)

**What goes wrong:** Berry MCP not loaded → hallucination check skipped silently. nomic-embed not loaded → embedding NULL silently. qwen3-coder-next not loaded → agentic runner returns 404 with cryptic error. User sees subtle quality degradation, can't trace it.
**Why it happens:** Optional services degrade gracefully by default. Designer user can't distinguish "missing feature" from "broken feature."
**Warning sign:** `relay doctor` doesn't check for each optional service. User reports "X used to work, now it doesn't."
**Prevention:** (1) **Doctor check per service** with explicit status: `berry: ok | not-loaded | error`, `lmstudio_embed: ok | model-missing | error`, `lmstudio_agentic: ok | model-missing | wrong-capability`. (2) Every feature dispatch path that uses an optional service writes a structured `service_status` field in result objects. (3) `relay info` rolls these up: `last_24h_service_health: berry 100%, embeddings 47%, agentic 12%`. (4) When a service degrades from green to yellow, **stderr warning on next invocation** so user sees the change.
**Phase to address:** Cross-cutting — doctor checks land WITH each feature, not after.

### CC.7: Stack Drift — Testing Framework / HTTP Client / Schema Validation

**What goes wrong:** New feature adds new dependency for "the right tool." Conflict detection imports `lodash.isequal`. Embeddings imports `ml-distance`. Figma imports `@figma/rest-api-spec`. Delta extraction switches from `zod` to `valibot` because "it's lighter." Stack diverges from v0.1.2's tight surface (vitest, undici/fetch, zod, better-sqlite3).
**Why it happens:** "Use the best tool for the job" reflex. Each individual decision is reasonable. Aggregate is fragmentation.
**Warning sign:** `package.json` grows by >5 new deps in v0.2. Two different ways to do JSON validation in src/. Two different HTTP clients.
**Prevention:** (1) **Stack lock** — document the v0.2 stack explicitly in STACK.md and CONTRIBUTING.md: vitest (tests), `undici` or native `fetch` (HTTP), `zod` (validation), `better-sqlite3` (storage), `nanoid` (IDs). Adding a dep requires explicit STACK.md update + rationale. (2) For each feature plan, the PLAN-*.md doc lists deps used; new deps highlighted for review. (3) Where possible, reuse: cosine similarity is 8 lines, don't add `ml-distance`. Variable validation is one zod schema, don't add `valibot`. (4) Lint: `grep -r "from 'lodash" src/` returns nothing.
**Phase to address:** Cross-cutting — STACK.md update is Phase 1 prerequisite.

### CC.8: Mock-Test Trap — Tests Pass, Production Breaks

**What goes wrong:** Embedding tests mock `/v1/embeddings` to return `[0.1, 0.2, ...]` (10 dims). Production nomic-embed returns 768 dims. Cosine works in tests because both sides are 10-dim. Production rows have 768-dim, query is 10-dim — mismatch. Or: Figma tests mock REST as instant; production has 200ms latency; agentic loop's wall-clock budget assumed instant.
**Why it happens:** Mocks are wishful thinking by default. They reflect the developer's mental model, not the service's actual behavior.
**Warning sign:** All mocked responses are "happy path." No mock returns the actual production payload size, error shapes, or latency.
**Prevention:** (1) **Mocks must use fixtures captured from real services**, not hand-written. For LM Studio: capture a real `/v1/embeddings` response, save as `__fixtures__/nomic-embed-768dim.json`. (2) **Integration test tier**: Phase 2-6 each have an `integration.test.ts` that runs against real LM Studio + real Figma if env-vars set, otherwise skips. CI runs them on nightly schedule. (3) Test against error shapes: 429 with `Retry-After`, 403 with Figma's specific message format, malformed `tool_calls` JSON. (4) Pre-flight in CI: `npm run test:integration` requires LM Studio loaded with the pinned models.
**Phase to address:** Cross-cutting — fixture-capture discipline from Phase 2 onward.

---

## "Looks Done But Isn't" Checklist

- [ ] **Agentic runner:** Tool-call hash loop detector implemented (not just iteration counter)?
- [ ] **Agentic runner:** Model capability probe runs before every dispatch (no assumed-loaded)?
- [ ] **Agentic runner:** Debug dump env var works and is documented?
- [ ] **Embeddings:** v0.1.2 DB fixture passes through migration + recall test?
- [ ] **Embeddings:** Doctor reports embedding coverage and service health?
- [ ] **Embeddings:** `embedding_model` column stored alongside vector data?
- [ ] **Conflict detection:** Detection at WRITE time, recall just reads JSON column?
- [ ] **Conflict detection:** `conflicts_with` references survive supersession of referent?
- [ ] **Delta extraction:** Hook returns exit 0 within 5s even when LM Studio hangs?
- [ ] **Delta extraction:** Berry hallucination gate active for ALL delta-extracted memories?
- [ ] **Delta extraction:** Repeats bump existing recall_count instead of writing duplicates?
- [ ] **Figma:** Bridge handshake required before first command?
- [ ] **Figma:** Doctor command checks plan tier, bridge, PAT, REST sample?
- [ ] **Figma:** PAT scrubbed from all debug logs?
- [ ] **Figma:** Enterprise-only tools removed from `tools[]` array for non-Enterprise users?
- [ ] **Cross-cutting:** No `throw` in cmd-*-hook.ts files (or wrapped in top-level catch)?
- [ ] **Cross-cutting:** No new `FROM memories` raw SQL outside `MemoryStore`?
- [ ] **Cross-cutting:** `memory-engine.ts` imports unchanged (still `./types`, `./constants` only)?
- [ ] **Cross-cutting:** Stack additions in STACK.md with rationale?
- [ ] **Cross-cutting:** Fixture-based mocks (not hand-written) for LM Studio + Figma?

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification Gate |
|---------|------------------|---------------------|
| 1.1 JSON fence drift | Phase 2 (agentic runner MVP) | Drift-detection test, model pinning in default config |
| 1.2 Token loop | Phase 2 | Hash-loop detector test passes |
| 1.3 Hidden preset | Phase 2 | Debug-dump flag works; WORKERS-MAP.md updated |
| 1.4 tool_call_id mismatch | Phase 2 | Byte-exact echo test (numeric + UUID IDs) |
| 1.5 Streaming bugs | Phase 2 | `stream: false` hard-coded; v0.3 roadmap entry exists |
| 2.1 Pure-function break | Phase 4 (embeddings) | Import-restriction CI check passes |
| 2.2 Backward compat | Phase 1 (fixture) + Phase 4 (recall fallback) | v0.1.2 fixture test green |
| 2.3 Dim mismatch | Phase 4 | `embedding_model` column + cross-model rejection test |
| 2.4 Silent fallback | Phase 4 | Stderr warning + doctor check |
| 2.5 Cosine bugs | Phase 4 | Fixture-based cosine tests (1.0, 0.0, -1.0 cases) |
| 3.1 O(N²) at recall | Phase 3 (conflict detection) | Benchmark <10ms p95 for 10K memories |
| 3.2 Stale references | Phase 3 | Supersede-with-conflict test |
| 3.3 Selection-loop entanglement | Phase 3 | `resolveConflicts` is pure, no DB import |
| 3.4 Annotate-vs-drop hardcoded | Phase 3 | `conflictPolicy` option exposed |
| 3.5 Spurious conflicts | Phase 3 (conservative threshold) + Phase 4 (cosine upgrade) | Manual test on consolidated workdir |
| 4.1 Context overflow | Phase 5 (delta extraction) | Pre-flight prompt-size check |
| 4.2 Repeat suppression | Phase 5 | Repeats bump recall_count, no new entry |
| 4.3 Hook blocks CC | Phase 5 | Queue-and-detach pattern; hook <5s timeout test |
| 4.4 Contradiction flood | Phase 5 | Contradictions stored as relationships, not entities |
| 4.5 Berry skipped | Phase 5 | Berry gate active in delta path |
| 5.1 Silent bridge fail | Phase 6 (Figma) | Hard error + doctor check |
| 5.2 Enterprise wall | Phase 6 | Plan-tier detection, tool filtering |
| 5.3 Port-scan race | Phase 6 | Handshake protocol in bridge v1 |
| 5.4 Rate-limit cascade | Phase 6 | Tool-wrapper sleep + retry; per-loop cap |
| 5.5 PAT leak | Phase 6 | Debug-log scrubber + .gitignore check |
| CC.1 v0.1.2 upgrade | Phase 1 | Fixture-based migration test |
| CC.2 Hook exit-0 erosion | Phase 2/4/5 | Top-level catch in every cmd-*-hook.ts |
| CC.3 Workdir leak | Phase 3+ | Cross-workdir contamination test per feature |
| CC.4 Pure-function erosion | Phase 1+ | CI import-restriction check |
| CC.5 LM Studio output drift | Phase 2/4/5 | `output-guard.ts` shared utility |
| CC.6 Silent service-down | Phase 2+ | Per-service doctor check |
| CC.7 Stack drift | Phase 1 (lock) + ongoing | STACK.md gate for new deps |
| CC.8 Mock-test trap | Phase 2+ | Fixture-based mocks + nightly integration tests |

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| JSON fence drift in production | LOW | Switch default model to `qwen/qwen3-coder-next`; user re-runs |
| Token loop burned budget | LOW | Loop detector logs; user reviews; tune hash-threshold |
| v0.1.2 → v0.2 broke recall | HIGH | Restore `~/.relay/backup-pre-v0.2.db`; bisect migration; ship hotfix |
| Embedding dim mismatch | MEDIUM | `relay memory rebuild-embeddings --model nomic-embed-text-v1.5 --workdir <path>` |
| Embedding silent NULL | MEDIUM | `relay memory rebuild-embeddings`; doctor flagged earlier should prevent |
| Conflict false positives | LOW | `relay memory consolidate` with merge; upgrade to cosine when Phase 4 lands |
| Delta extraction hallucinations | MEDIUM | `relay memory rollback --since <date>`; tighten Berry threshold |
| Figma PAT leaked | HIGH | Revoke PAT in Figma settings; scrub git history with `git-filter-repo`; rotate |
| Figma rate-limit lockout | LOW | Wait for window reset (~1 hour); add per-loop cap |
| Workdir contamination | HIGH | Manual audit of cross-workdir entries; rebuild from `.relay/backup-*` |
| Hook breaks CC | MEDIUM | `relay pause` immediately; fix hook; `relay resume` |
| Stack drift accumulated | HIGH | Codify in STACK.md; deprecate offending dep gradually |

---

## Sources

Grounded in:
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/PROJECT.md` (Key Decisions, validated requirements)
- `/Users/ghanavati/ai-stack/Projects/Relay/ROADMAP.md` (feature scope)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/ROADMAP-DRIFT.md` (line/file drift incidents)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/LMSTUDIO-TOOL-API.md` (LFM2 Pythonic, Qwen drop, Gemma MLX, GLM preset)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/FIGMA-API-TOOLS.md` (REST vs Plugin API, Enterprise wall, bridge architecture)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/EMBEDDING-PATTERN.md` (pure-function preservation)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/DELTA-MEM-CONFLICT.md` (A-MEM reciprocal references, Letta annotate-not-delete)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/AGENTIC-WORKER-PATTERN.md` (timeout+iteration cap, error-path requirements)
- Codex wave-4 audit history (P1/P2 findings re: workdir scoping, hook exit codes, pure-function violations)
- User memory: `feedback_lmstudio_routing.md` (GLM preset injection, qwen3-coder routing)

---

*Pitfalls research for: Relay v0.2 (5 features + cross-cutting integration concerns)*
*Researched: 2026-05-18*
