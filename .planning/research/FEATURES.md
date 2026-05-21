# Feature Research — Relay v0.2

**Domain:** Local-first LLM CLI — agentic tool-use + memory upgrades + Figma integration
**Researched:** 2026-05-18
**Confidence:** HIGH (LM Studio + δ-mem + Mem0/A-MEM verified from primary sources; Figma MCP/REST verified from Figma blog + Composio; competitor patterns from Claude Code/Aider/Continue docs + issues)
**Scope:** Five v0.2 features layered on top of Relay v0.1.2 (already shipped: single-shot workers, word-overlap memory, auto-extract, privacy gates)

---

## Feature 1 — Agentic LM Studio Worker (Tool-Calling Loop)

**Existing dependency:** `src/workers/lmstudio.ts` (single-shot, `agentic: false`), `WorkerTask`/`WorkerResult` contracts in `src/workers/types.ts`, dispatch in `src/cli/cmd-run.ts`.

### What users expect (minimum viable behavior)

- Submit a task with a tool set, get a final text answer back — same shape as existing single-shot workers, plus a tool-call count
- Tools execute locally (no remote tool sandboxes); results echo back into the loop
- Loop terminates: either model says "done" (`finish_reason: "stop"`), iteration cap hits, or a loop-detector trips
- Errors during tool execution surface as a tool-result message the model can react to — not a hard abort
- Works with the already-loaded local model (no separate setup beyond LM Studio + a tool-capable model)

### Table stakes

| Feature | Why expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Hard iteration cap (default 20) | Prevents runaway loops on a local model that burns memory/CPU | LOW | ROADMAP §2 already calls for 20; Claude Code uses `maxTurns` for same reason ([issue #4277](https://github.com/anthropics/claude-code/issues/4277)) |
| `finish_reason` parsing (`stop` vs `tool_calls`) | Standard OpenAI shape; LM Studio mirrors it exactly | LOW | Documented in LMSTUDIO-TOOL-API.md §"HTTP Shape — Response" |
| `tool_call_id` round-trip | OpenAI spec requirement; LM Studio uses arbitrary numeric strings, must echo exactly | LOW | LMSTUDIO-TOOL-API.md §"Tool result message" |
| `JSON.parse` of `function.arguments` with try/catch | Arguments arrive as JSON-encoded string, can be malformed | LOW | Error mode in LMSTUDIO-TOOL-API.md §"Error Modes" |
| Multiple parallel tool calls per turn | OpenAI spec; some models emit several `tool_calls[]` in one response | LOW | Execute all, append all results before next request |
| Model capability pre-check | `GET /api/v0/models` → filter `capabilities` includes `"tool_use"` | LOW | Fail fast on misconfigured model; LM Studio v0.3.16+ |
| Tool exec timeout per call | Prevents one slow tool from blocking the loop forever | LOW | 30s default; configurable |
| Per-tool result size limit | Prevents one tool dumping 100MB into context | LOW | Truncate + flag; default 8KB per tool result |

### Differentiators vs Continue / Aider / Claude Code / Cursor

| Feature | Why distinctive for Relay | Complexity |
|---------|---------------------------|------------|
| Loop detector by `(name, sorted_args)` hash | Continue/Aider rely only on counters; Claude Code's `--max-turns` "does not catch tight loops" per [issue #4277](https://github.com/anthropics/claude-code/issues/4277). Hash 3-in-a-row matches = stuck. | MEDIUM |
| Memory injection on every turn via existing `contextPrefix` | Re-use the v0.1 cross-LLM context emit — most local-LLM tool runners don't have any persistent memory layer | LOW (already built) |
| Pause sentinel + workdir allowlist respected mid-loop | Existing privacy gates inherited automatically; check before each tool call | LOW (re-use) |
| Berry hallucination check on the final answer | Same gate as auto-extract; one-line extension | LOW (re-use) |
| Zero new external dependencies | Plain `fetch`, no `openai` SDK — preserves Relay's "minimal surface" stance | LOW |
| Configurable loop budget per task | `task.maxIterations` override on `WorkerTask` (default 20) | LOW |

### Anti-features (DO NOT BUILD in v0.2)

| Anti-feature | Why requested | Why problematic for Relay | Alternative |
|--------------|---------------|---------------------------|-------------|
| Streaming tool-call deltas | "Real-time feel" | Doubles complexity (per-index accumulation, partial JSON), no CLI UX gain in v0.2 | `stream: false`; add later in v0.3 if TUI ships |
| In-process tool handler registry | "Type-safe tools, no shelling" | Locks tool definitions to TypeScript; can't share with Codex worker; harder to test in isolation | Start with shell-command tools (same pattern as Codex), like ROADMAP §2 recommends |
| Anthropic-compat `/v1/messages` LM Studio endpoint | Newer, supports Claude-Code-style tool calls | LM Studio v0.4.1 only; not battle-tested; loses parity with OpenAI shape used by GLM/Gemma/LFM2 | Stick with `/v1/chat/completions` — works for every loaded model |
| `/v1/responses` endpoint (LM Studio v0.3.29) | Remote MCP server support, simpler client | New surface; doesn't unblock Figma; non-critical for v0.2 | Defer to v0.3 |
| Forced `tool_choice: "required"` everywhere | "Make the model use tools" | MLX builds may not honor it (changelog scopes to llama.cpp only) | `"auto"` + clear system prompt naming the tools |
| Auto-detect tool definitions from doc-strings | "Magic" | Brittle parser, surprising behavior | Explicit OpenAI tool-definition objects passed via `WorkerTask.tools` |
| Recursive sub-agent spawning from inside the loop | "Agentic depth" | Permission model, memory injection, and budget tracking explode | Single-level loop only; Codex worker is the recursion path if needed |

### Behavior under failure

| Failure mode | Detection | Relay response |
|--------------|-----------|----------------|
| LM Studio not loaded / wrong model loaded | `GET /api/v0/models` pre-flight fails or capability check misses `"tool_use"` | Return `WorkerResult` with `status: "skipped:model_unavailable"`, exit 0 — never block CC hooks (per `PROJECT.md` Key Decisions) |
| Network timeout to `localhost:1234` | `fetch` timeout (default 60s) | `status: "skipped:network"`, no retry inside the loop; user re-runs |
| Malformed `tool_calls` JSON (model wrote it as plain text) | `tool_calls` empty AND `content` matches tool-call-looking regex | Log warning; append synthetic system reminder "format tool calls as JSON"; one retry, then abort |
| `function.arguments` not valid JSON | `JSON.parse` throws | Append tool result: `{"error":"arguments not valid JSON: <message>"}`, let model self-correct (no abort) |
| Tool execution throws | `await tool(args)` rejects | Append tool result: `{"error":"<msg>","stack":"<trimmed>"}` — let model retry or change approach |
| Loop detector fires (3× same hash) | Hash of `(name + sorted_args)` matches 3 consecutive turns | Abort with `status: "failed:loop_detected"`, include the repeating call in result diagnostics |
| Iteration cap hit (20 by default) | Counter exceeds limit | Abort with `status: "failed:max_iterations"`, return last assistant message as best-effort |
| Context overflow mid-loop | `usage.total_tokens` approaches model context | Trim oldest tool-result `content` (summarize stub); if still overflowing, abort `status: "failed:context_overflow"` |
| Pause sentinel appears mid-loop | Check before each iteration | Graceful exit with `status: "skipped:paused"`, partial result returned |

**Complexity:** L (largest item in v0.2 — touches dispatch, types, new worker, loop control, error taxonomy). Estimate: ~600-900 LoC + tests.

---

## Feature 2 — Semantic Embeddings on Memory Store

**Existing dependency:** `computeContentScore()` in `src/memory/memory-engine.ts:59` (word-overlap), `scoreMemoryDetailed()` for `ScoreComponents`, `MemoryStore.remember()` in `src/memory/memory-store.ts`, `db-migrations.ts` PRAGMA-guarded ALTER pattern.

### What users expect (minimum viable behavior)

- Recall finds semantically related memories even when surface words don't match ("naming conventions for stylesheets" → finds "prefer kebab-case for CSS")
- Existing memories keep working (graceful fallback to word-overlap if `embedding_json IS NULL`)
- No external API key required — runs against LM Studio (`nomic-embed-text-v1.5`, 768-dim, GGUF, [verified on HF](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5))
- Write-time embedding adds latency but doesn't block `remember()` from succeeding when embedding fails
- Score components still inspectable via `relay memory why <id>` (cosine score visible as a component)

### Table stakes

| Feature | Why expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Cosine similarity scoring | Standard for embedding recall | LOW | Pure-function math; pass pre-computed similarity as parameter to `scoreMemoryDetailed()` (preserves pure-function design) |
| `embedding_json TEXT` column with PRAGMA-guarded ALTER | Matches existing migration pattern (`db-migrations.ts:88`) | LOW | One ALTER, default NULL, no migration cost |
| Graceful fallback to word-overlap | Old memories + LM Studio offline scenarios | LOW | If `embedding_json IS NULL` OR LM Studio embed call fails, current scoring runs unchanged |
| Capability pre-check before embed | Don't burn `remember()` latency if no embed model loaded | LOW | `GET /api/v0/models` filter for embedding capability once at startup, cache result for session |
| Length-prefixed query encoding | nomic-embed-v1.5 requires `search_query: ` / `search_document: ` prefix for proper scoring ([Nomic docs](https://docs.nomic.ai/atlas/embeddings-and-retrieval/generate-embeddings)) | LOW | Easy to get wrong — bake into the wrapper, not exposed to callers |
| Embedding store as JSON-encoded array of floats | SQLite has no native vector type; better-sqlite3 doesn't need sqlite-vec for this scale | LOW | At <10k memories, JS cosine over JSON-parsed arrays is sub-50ms; sqlite-vec is overkill |

### Differentiators

| Feature | Why distinctive | Complexity |
|---------|-----------------|------------|
| 100% local — no cloud embedding API | OpenAI/Voyage/Cohere are common defaults in tools like Mem0; Relay uses the existing LM Studio install | LOW (already the design) |
| Cosine score visible in `ScoreComponents` for `relay memory why` | Most memory tools hide their similarity math | LOW |
| Used inside `consolidation.ts` to catch paraphrase duplicates | Existing Jaccard misses paraphrases; embedding catches "use spaces not tabs" ≈ "indent with spaces" | MEDIUM |
| Embedding feeds the conflict detector's "residual" axis (Feature 3) | Two-tier conflict: tag-overlap + embedding-divergence is much stronger than tag-overlap + word-Jaccard alone | (counted in Feature 3) |

### Anti-features

| Anti-feature | Why requested | Why problematic | Alternative |
|--------------|---------------|-----------------|-------------|
| Cloud embedding API (OpenAI ada / Voyage / Cohere) | "Better quality" | Violates local-first core value; introduces API key management, network failure modes, costs, privacy leak | LM Studio + nomic-embed-text-v1.5 — same OpenAI shape, zero cloud |
| sqlite-vec / sqlite-vss extension | "Real vector DB" | New native dep, breaks the "single SQLite file, no extensions" portability bet; <10k memories doesn't justify it | JSON-encoded array + JS cosine; revisit only if recall latency exceeds 200ms |
| Background re-embedding queue for legacy memories | "Don't leave old data behind" | Adds a worker process, breaks the "stateless CLI" model | Embed lazily on next access OR offer `relay memory reembed --workdir <path>` one-shot command (v0.3) |
| Hybrid BM25 + embedding rank fusion | "Best of both worlds" | Reciprocal rank fusion adds tuning surface (k=60? per-component weights?); FTS5 already exists for keyword | Compose linearly in `scoreMemoryDetailed()`: keep existing word-overlap weight, add cosine as new component with documented weight |
| Re-rank with LLM after embedding | "Higher precision" | Doubles latency; requires another LM Studio call per recall | Embedding-only re-rank; LLM-as-judge deferred |
| Persist quantized embeddings (int8/binary) | "Save space" | 768 × 4 bytes × 10k memories = 30MB JSON — negligible | Plain float32 JSON until store exceeds 100k rows |
| Multi-model embedding ensembles | "Robustness" | Embedding-space mismatch makes cosine meaningless across models | One model per memory store; record `embedding_model` in column for future migration |

### Behavior under failure

| Failure mode | Detection | Relay response |
|--------------|-----------|----------------|
| Embedding model not loaded | Capability pre-check fails | `remember()` succeeds with `embedding_json = NULL`; log info "embedding skipped: no model"; recall falls back to word-overlap |
| LM Studio offline at write time | `fetch` to `/v1/embeddings` rejects | Same as above — write succeeds, embedding skipped |
| LM Studio offline at recall time | `fetch` for query embedding rejects | Fall back to word-overlap for all candidates this recall; log warning; recall succeeds |
| Embedding API returns wrong dimension | Length check fails (expect 768) | Reject the embedding, fall back; log error with received dim |
| `embedding_json` malformed for a stored row | `JSON.parse` throws | Treat that row as `embedding_json = NULL`; surface in `relay doctor` as repairable |
| Cosine score is NaN (zero vector) | `Number.isNaN(score)` | Drop the row from candidates; log warning |
| Length-prefix forgotten (regression) | Test fixture: query "kebab-case" should score >0.5 against doc "use kebab-case for CSS" | Caught in unit tests |

**Complexity:** M (one column, one ALTER, two new wrapper functions, recall-loop change, fallback path). Estimate: ~300-500 LoC + tests.

---

## Feature 3 — Conflict Detection in Memory Recall

**Existing dependency:** `MemoryStore.remember()`, `budgetedRecall()` at `src/memory/memory-engine.ts:195`, `scoreMemoryDetailed()`, `getCandidates()`, `db-migrations.ts` pattern. DELTA-MEM-CONFLICT.md is the primary algorithmic spec.

### What users expect (minimum viable behavior)

- When two memories directly contradict each other, recall surfaces the conflict (not both silently injected)
- Default mode is `ANNOTATE_BOTH` — drop nothing, decorate both with `⚠ CONFLICTS WITH #N` so the consuming LLM sees the conflict and decides
- Reciprocal: detection at write time updates both the new memory AND the conflicting older ones (per A-MEM precedent)
- Pinned memories never get dropped (only annotated)
- `relay memory why <id>` shows conflict signals alongside `ScoreComponents`

### Table stakes

| Feature | Why expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `conflicts_with_json TEXT DEFAULT '[]'` column via PRAGMA-guarded ALTER | Matches existing migration pattern | LOW | DELTA-MEM-CONFLICT.md §4 |
| Tag-jaccard + content-jaccard heuristic at write time | High tag overlap + low content overlap = same key, different value | MEDIUM | DELTA-MEM-CONFLICT.md §4, threshold defaults 0.5 / 0.3 |
| Workdir scoping (compare only within same workdir) | Cross-project false positives are the most common failure | LOW | Already in SQL prefilter |
| Memory-type matching (never compare `decision` to `fact`) | Different memory types are not commensurable | LOW | One extra `WHERE` clause |
| Reciprocal update on detection | Both memories carry the conflict pointer | LOW | Per A-MEM lesson, DELTA-MEM-CONFLICT.md §3 |
| Pairwise pass in `budgetedRecall()` between sort and pack | Conflict is pairwise, scoring is unary — keep them separate (preserves `scoreMemory` purity + test coverage) | MEDIUM | DELTA-MEM-CONFLICT.md §5 |
| Provenance → confidence → recency tiebreaker | Convention from multi-agent memory survey; matches Relay's higher-stakes use case | LOW | DELTA-MEM-CONFLICT.md §6 |
| Thresholds in a single constants file | Tunable without code change; testable in isolation | LOW | `src/memory/conflict-thresholds.ts` |
| Min-shared-tags floor (≥2) | Drops single-tag false positives | LOW | DELTA-MEM-CONFLICT.md §8 mitigation |

### Differentiators

| Feature | Why distinctive | Complexity |
|---------|-----------------|------------|
| Cheap symbolic features first (no LLM call per write) | Mem0 calls an LLM on every write; Relay stays local + fast | LOW (it's the design) |
| Annotation-by-default (`ANNOTATE_BOTH`) | Letta: "agent decides via tools"; Mem0: "latest truth wins, soft-delete"; Relay: surface to consumer, let it judge | LOW |
| Pinned memories immune to drop | Most systems treat all memories uniformly; Relay's trust-tier system gives pinning real weight | LOW |
| Conflict visible in `relay memory why` (audit trail) | Most memory tools hide internal flags | LOW |
| Drop mode behind feature flag | `recall.options.conflict_resolution: 'drop'` for users who want stronger filtering | LOW |
| Two-tier residual (tag-jaccard now, embedding-cosine later) | When Feature 2 lands, embedding gives a true residual signal close to δ-mem's `(v − S·k)` magnitude | (composes) |

### Anti-features

| Anti-feature | Why requested | Why problematic | Alternative |
|--------------|---------------|-----------------|-------------|
| Auto-delete losing memory | "Latest truth wins, simpler recall" | Loses audit trail; heuristic false positives become irrecoverable | `ANNOTATE_BOTH` default; soft-delete via existing `superseded_by` only when explicit user action |
| LLM-judge for every write | "More accurate" (Mem0 pattern) | One LLM call per `remember()` is unacceptable at the rate Relay writes — would slow hooks; cost burn even local | Heuristic-only in v0.2; LLM-judge as v0.3 fallback for ambiguous pairs (false-positive rate >5%) |
| Conflict resolution UI prompt | "Let user pick the winner" | Synchronous user interaction breaks `relay run` flow; doesn't fit CLI ergonomics | Annotation only; offer `relay memory conflicts <id>` review command in v0.3 |
| Unify `superseded_by` and `conflicts_with_json` | "Single source of truth" | They serve different roles — `superseded_by` is deterministic dedup, `conflicts_with_json` is heuristic semantic | Keep separate (DELTA-MEM-CONFLICT.md §10 open question, resolved as "separate") |
| Pattern mining across the conflict graph | "Detect topic drift" | Premature; need real data first | Defer to v0.3 (PaTeCon-style) |
| `relay memory conflicts <id>` user-facing subcommand | "Inspect conflicts" | Useful but not blocking for v0.2; data is in `memory why` already | Defer to v0.3 |

### Behavior under failure

| Failure mode | Detection | Relay response |
|--------------|-----------|----------------|
| Candidate set has zero rows (no tag overlap) | SQL returns empty | Skip conflict detection silently — write proceeds, `conflicts_with_json = '[]'` |
| `M_new` has fewer than 2 tags | Length check at top of `Step W1` | Skip conflict detection (too few tags = too many false positives) |
| Reciprocal UPDATE on conflicting memory fails | DB write error | Log warning; the new memory still gets its `conflicts_with_json` — asymmetric flag is recoverable; surface in `relay doctor` |
| Recall finds conflicts but all are pinned | Pinned-status check | Annotate all, drop none |
| Threshold tuning produces high false-positive rate | Operator review of `relay memory why` annotations | Constants in `conflict-thresholds.ts` — change without code edit |
| Conflict pair has tied trust, tied score, and same `created_at` | Tiebreaker exhausted | Annotate both (no winner needed in `ANNOTATE_BOTH` mode); fail gracefully — never throw |
| Loser-drop frees budget mid-recall | Greedy pack invariant broken if not handled | Backfill from omitted list (DELTA-MEM-CONFLICT.md §10 #4) |
| Existing 972 tests | Regression on scoring purity | `scoreMemory` stays pure — pairwise pass lives outside it; new tests for `pairwiseConflictPass()` covering 4 classifier cases |

**Complexity:** M (one column, write-time detector, recall-time pairwise pass, tiebreaker, thresholds module). Estimate: ~400-600 LoC + tests. Independent of Feature 2 but enhanced by it.

---

## Feature 4 — Delta Extraction in Auto-Extract

**Existing dependency:** `src/memory/auto-extract-runner.ts`, `src/memory/auto-extract-transcript.ts` (32KB trailing transcript window), T10 prompt template, `MemoryStore.getCandidates()`, consent file gate (per workdir).

### What users expect (minimum viable behavior)

- Auto-extract doesn't re-emit lessons that already exist in memory (no growing pile of near-duplicates)
- New extractions that contradict existing memory get explicit flags (not silently merged or appended)
- Existing privacy gates still apply (consent file, `.relayignore`, PII redaction, workdir allowlist, Berry hallucination check)
- Quality of extraction improves measurably — fewer duplicates, more genuine new information per run

### Table stakes

| Feature | Why expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Load existing memories for workdir before extraction | The core delta primitive: model needs to know what's already known | LOW | One call to `MemoryStore.getCandidates({ workdir })` |
| Inject existing patterns into T10 prompt | Modified prompt: "Extract only what ADDS, CONTRADICTS, or REFINES…" | LOW | Prompt-engineering change; ROADMAP §6 |
| Token budget for existing-memories context | Don't blow past LM Studio context limit | LOW | Cap at 8KB existing context inside the 32KB transcript window |
| `memory_source: "delta"` or `conflicts_with: [...]` on outputs | Differentiates delta-extracted from full-extracted | LOW | New `memory_source` enum value + optional `conflicts_with` field on extraction schema |
| Backward-compat: empty existing-set → falls back to v0.1 behavior | First-run workdirs still work | LOW | Branch on `existing.length === 0` |
| Zod validation extended for new fields | Same `{content, memory_type, confidence}` + optional `conflicts_with` | LOW | Single-line schema addition |

### Differentiators

| Feature | Why distinctive | Complexity |
|---------|-----------------|------------|
| Feeds directly into the conflict-detection system (Feature 3) | A contradicting auto-extracted lesson lands with the `conflicts_with` pointer already set | LOW (composes) |
| All-local, consent-gated, PII-redacted, hallucination-checked | No other tool combines delta extraction with this many privacy gates | LOW (re-use) |
| Token-efficient prompting | Inject only top-K candidates by tag-overlap with the transcript window, not the whole workdir's memory | MEDIUM |
| Trust-tier-aware suppression | Verified memories block re-extraction; unverified memories can be refined by new evidence | LOW |
| Visible in `relay memory why` why a delta was/wasn't recorded | Audit trail for "did the system suppress this lesson because it knew it?" | LOW |

### Anti-features

| Anti-feature | Why requested | Why problematic | Alternative |
|--------------|---------------|-----------------|-------------|
| Per-line transcript diffing | "Real delta" | Transcripts aren't diffable — they're conversation logs, not files | Semantic delta via the prompt + Feature 3 conflict detection |
| Auto-merge contradicting lessons | "Resolve conflicts inline" | Loses provenance; same problem as auto-delete in Feature 3 | Emit both; let conflict detector annotate |
| Reduce extraction frequency to compensate | "Less noise" | Hides the symptom; misses real new information between extractions | Delta extraction IS the fix; frequency stays the same |
| Inject every workdir memory into prompt | "Maximum context" | Blows token budget; degrades extraction quality | Top-K by tag-overlap with transcript content (estimate: K=20) |
| Streaming partial extractions | "Faster feedback" | Adds parsing complexity; auto-extract runs on `SessionEnd` — no user is waiting | One-shot extraction; sync; same as v0.1 |
| Delta extraction across workdirs | "Global learning" | Violates workdir scoping (privacy + relevance) | Per-workdir only; matches existing `RELAY_MEMORY_ALLOWED_WORKDIRS` model |
| LLM-driven "is this novel?" filter | "Higher precision" | Adds a second LLM call per candidate lesson | Trust the model to follow the modified T10 prompt; measure false-novelty rate, iterate |

### Behavior under failure

| Failure mode | Detection | Relay response |
|--------------|-----------|----------------|
| `getCandidates()` returns zero (first-run workdir) | Length check | Fall back to v0.1 extraction prompt (no delta framing) |
| Existing context exceeds 8KB budget | Length check post-serialization | Trim to top-K by tag-overlap with transcript |
| LM Studio offline | `fetch` rejects | Already handled by `auto-extract-runner.ts` — extraction skipped, hook exits 0 |
| Model emits a "delta" that's actually a duplicate | Existing dedup pipeline still runs after extraction | Caught at `MemoryStore.remember()` SHA dedup |
| Model emits a "delta" tagged `conflicts_with` referencing a non-existent ID | Validation against active memory IDs | Drop the `conflicts_with` field, keep the lesson; log warning |
| Zod schema rejects the model output | Existing validation | Already handled — skip the malformed entry, continue with others |
| Berry hallucination gate rejects the delta | Existing gate | Drop the lesson; log; consent file unchanged |
| Modified prompt confuses an older model | Quality regression | Pin extraction model to `qwen3-coder-next` (already the default); test fixture catches regression |
| Consent file revoked mid-window | Existing pre-extraction check | Already handled — skip extraction, exit 0 |

**Complexity:** S-M (prompt change + one query + schema extension + integration with Feature 3). Estimate: ~200-350 LoC + tests. Depends on Feature 3 for the conflicts_with surface.

---

## Feature 5 — Figma Integration (4 Tools)

**Existing dependency:** Feature 1 (agentic LM Studio runner) — Figma tools only callable through a tool-loop. Existing Codex Figma was explicitly disabled (`DISABLED_CODEX_MCP_LABELS = new Set(['figma', 'notion', 'pencil'])` in `src/workers/codex.ts`).

### What users expect (minimum viable behavior)

- A local LLM (no API cost, offline driving) can create/modify Figma components, query design tokens, manage layers
- Memory injection works — design-system rules stored as `fact` memories get recalled into the system prompt at run time, so the model "knows your tokens" without re-uploading
- Authentication is one-time via Figma personal access token (PAT), stored locally
- Tools fail gracefully when Figma file is read-only, token expired, or file ID invalid
- Each tool execution is logged + auditable (which tool, which file, what changed)

### Table stakes

| Feature | Why expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `figma_create_component` tool | Most common design-to-code workflow | MEDIUM | Maps to Figma REST `POST /v1/files/:key/components` or via Plugin API bridge |
| `figma_update_token` tool | Design-token sync is a primary use case | MEDIUM | Variables API (Figma's design-token primitive) |
| `figma_get_selection` tool | Read current Figma state for context | LOW | REST `GET /v1/files/:key/nodes?ids=...` (selection requires plugin bridge for actual UI selection) |
| `figma_list_layers` tool | Navigate a file's structure before editing | LOW | REST `GET /v1/files/:key` returns full document tree |
| PAT stored in `~/.relay/secrets/figma.json` (chmod 600) | Standard local secret storage | LOW | Match existing `~/.relay/` pattern; no env-var requirement |
| Rate-limit awareness (Figma 60 req/min default) | Standard for any REST integration | LOW | Token-bucket in the worker; back-off + retry once on 429 |
| Workdir-scoped Figma file binding | Per-project file IDs in `<workdir>/.relay/figma.json` | LOW | Avoids cross-project leakage; matches consent-file pattern |

### Differentiators

| Feature | Why distinctive | Complexity |
|---------|-----------------|------------|
| Driven by a local 80B-class MoE (`qwen3-coder-next`) — no cloud LLM cost | Figma + Claude Code / Cursor pairs require cloud API; Relay does it offline | (counted in Feature 1) |
| Design-system rules persist across sessions via `relay memory` | "Train it on your design system" requirement met by existing memory layer | LOW (re-use) |
| All API calls + tool args logged to memory store as `event` type | Audit trail for what the LLM did to the file | LOW |
| Workdir-scoped file ID + PAT | Different design files per project; switch by `cd`-ing | LOW |
| Berry hallucination check on the final summary | Existing gate ensures the model didn't claim it did something it didn't | LOW (re-use) |
| Dry-run mode (`--dry-run` flag) | Show planned API calls without executing — Cursor/Continue lack this for Figma | LOW |

### Anti-features

| Anti-feature | Why requested | Why problematic | Alternative |
|--------------|---------------|-----------------|-------------|
| Bundling the Figma MCP server | "Less code to maintain" | Adds Node child-process management; ties to Figma's MCP server lifecycle (deprecated/changed APIs); Composio + Figma MCP server have their own caveats | Direct REST + Variables API call from the tool handler |
| 23-tool Community MCP surface (createRect, setPadding, addComponentInstance, …) | "Maximum coverage" | Overwhelming for an MVP; 4 tools cover 80% of design-to-code workflows | Start with the 4 listed; add more in v0.3 driven by real use |
| OAuth flow for Figma auth | "Production-grade auth" | Requires a redirect URI, registered app, callback handler — way out of scope for a CLI | PAT only; sufficient for single-user |
| Real-time Figma plugin (in-canvas UI) | "Live design feedback" | Requires Figma plugin runtime + WebSocket bridge — separate project | REST API only; user works in Figma + CLI side-by-side |
| Auto-commit Figma changes to git | "Versioning" | Figma is the SoT for the design; binary file conflicts | Log changes to memory as `event` rows; user pulls into their own design-versioning workflow |
| Cross-file refactoring | "Like jscodeshift for Figma" | Multi-file API calls, dependency analysis — large project on its own | Single-file scope per `relay run` invocation |
| Render-and-diff after each tool call | "Visual verification" | Requires image rendering; cannot be done from the REST API alone; slow | Defer; rely on the model's reasoning + user review in Figma |

### Behavior under failure

| Failure mode | Detection | Relay response |
|--------------|-----------|----------------|
| Figma PAT missing | File check at worker init | Hard fail with `status: "skipped:figma_auth"` + setup instructions; no API call attempted |
| Figma PAT expired (401) | HTTP status | Append tool result with clear error + remediation; model can give up gracefully |
| Figma file ID invalid (404) | HTTP status | Tool result with error; model retries with different file (if available) or aborts |
| Figma file read-only (403 on write) | HTTP status | Tool result; model falls back to read-only tools |
| Rate-limited (429) | HTTP status + `Retry-After` header | Worker waits per header (capped at 30s), one retry; if still rate-limited, tool result with error |
| Figma API timeout | `fetch` timeout (30s per tool call) | Tool result with timeout error; loop continues, model can try a different approach |
| Tool args reference a non-existent node ID | Figma returns 404 on the node | Tool result with error; model can re-query layers first |
| Concurrent edit (someone else modified the file) | Figma returns 409 or unexpected state | Tool result; model re-queries before retrying |
| LM Studio loop fires loop-detector (Feature 1) on Figma tools | Same hash 3× | Abort with `status: "failed:loop_detected"`, partial Figma changes already committed remain |
| Workdir not allowlisted | Existing `RELAY_MEMORY_ALLOWED_WORKDIRS` check | Hard fail before tool exec |
| Pause sentinel mid-loop | Existing gate | Graceful exit; partial Figma changes remain |

**Complexity:** M-L (4 tool implementations + auth + rate-limit + workdir binding). Estimate: ~500-700 LoC + tests (does NOT count the agentic runner from Feature 1). Hard dependency on Feature 1.

---

## Feature Dependencies

```
Feature 1: Agentic LM Studio Runner
    │
    ├──required-by──> Feature 5: Figma Integration
    │                 (Figma tools only callable through a tool-loop)
    │
    └──enhances────> Feature 4: Delta Extraction
                     (delta extraction calls LM Studio; if loop-capable runner exists,
                      could later evolve into agentic extraction; v0.2 still single-shot)

Feature 2: Semantic Embeddings
    │
    ├──enhances────> Feature 3: Conflict Detection
    │                (embedding cosine becomes a true residual axis; v0.2 ships with
    │                 word-jaccard residual, Feature 2 strengthens it post-merge)
    │
    └──enhances────> Feature 4: Delta Extraction
                     (existing-pattern top-K selection by embedding instead of tag-overlap)

Feature 3: Conflict Detection
    │
    └──required-by──> Feature 4: Delta Extraction
                      (delta output's `conflicts_with` field requires the conflict column
                       and pairwise pass to be meaningful at recall time)

Feature 5: Figma Integration ──depends-on──> Feature 1 (HARD)
Feature 4: Delta Extraction ──depends-on──> Feature 3 (SOFT — works without, but underpowered)
```

### Dependency Notes

- **Feature 1 → Feature 5 (HARD):** Figma tools only make sense inside a tool-call loop. Single-shot LM Studio cannot drive Figma. Feature 5 must land in a later phase than Feature 1.
- **Feature 3 → Feature 4 (SOFT):** Delta extraction can emit a `conflicts_with` field, but if Feature 3's column + pairwise pass don't exist, that field has no consumer. Land Feature 3 first; ship Feature 4 immediately after.
- **Feature 2 → Feature 3 (SOFT):** Conflict detection works with word-jaccard residual (v0.2 baseline). Feature 2 upgrades the residual to embedding-cosine post-launch — no rework, just a constant swap in `conflict-thresholds.ts`.
- **Feature 2 ↔ Feature 4 (SOFT):** Delta extraction's top-K candidate selection benefits from embedding similarity over tag-overlap. Can ship Feature 4 with tag-overlap first; swap in embedding after Feature 2.

### Conflict notes

- **None of the five features conflict with each other.** All five are additive on top of v0.1.2's contracts.

---

## MVP Definition (this milestone is v0.2 — not v1)

Relay v0.1.2 already shipped. v0.2 is itself an MVP for "agentic + semantic memory" — every feature here is a "should ship in v0.2" item, not "defer to v0.3".

### Land in v0.2

- [x-pending] **Schema cleanup** — prerequisite, drops orphaned tables, adds `schema_version` table (already in ROADMAP §1)
- [x-pending] **Feature 1: Agentic LM Studio runner** — unblocks Feature 5; standalone value for any tool-using local task
- [x-pending] **Feature 3: Conflict Detection** — highest-value memory improvement; self-contained
- [x-pending] **Feature 2: Semantic Embeddings** — improves recall quality across everything
- [x-pending] **Feature 4: Delta Extraction** — builds on Feature 3
- [x-pending] **Feature 5: Figma Integration** — builds on Feature 1
- [x-pending] **Budget command** (separate from this research scope — already in ROADMAP §7)

### Defer to v0.3+

- [ ] Streaming tool-call deltas (Feature 1) — wait for TUI
- [ ] `/v1/responses` and `/v1/messages` LM Studio endpoints (Feature 1) — non-critical
- [ ] In-process tool registry (Feature 1) — shell-command path is simpler to start
- [ ] sqlite-vec extension (Feature 2) — only if recall latency degrades
- [ ] LLM-judge for ambiguous conflicts (Feature 3) — only if false-positive rate >5%
- [ ] `relay memory conflicts <id>` subcommand (Feature 3) — annotation in `memory why` covers it
- [ ] Background re-embedding queue for legacy memories (Feature 2) — one-shot CLI command instead
- [ ] LLM-driven novelty filter for delta extraction (Feature 4) — iterate on prompt first
- [ ] Real-time Figma plugin bridge (Feature 5) — separate project
- [ ] OAuth for Figma (Feature 5) — PAT is sufficient for single-user

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Why |
|---------|------------|---------------------|----------|-----|
| Schema cleanup | LOW | LOW | P1 | Prerequisite for clean v0.2 baseline |
| Feature 1: Agentic LM Studio | HIGH | HIGH | P1 | Unblocks Figma + all tool-use workflows |
| Feature 3: Conflict Detection | HIGH | MEDIUM | P1 | Self-contained, highest memory-quality lift |
| Feature 2: Semantic Embeddings | HIGH | MEDIUM | P1 | Improves recall across everything |
| Feature 4: Delta Extraction | MEDIUM | LOW-MEDIUM | P2 | Composes with Feature 3; lower standalone value |
| Feature 5: Figma Integration | MEDIUM | MEDIUM-HIGH | P2 | High demand but narrow surface; depends on Feature 1 |

**Priority key:**
- P1: Must have for v0.2
- P2: Should have, ships in v0.2 if Feature 1 lands cleanly

---

## Competitor Feature Analysis

| Feature | Claude Code | Cursor | Continue | Aider | Mem0 | Relay v0.2 |
|---------|-------------|--------|----------|-------|------|------------|
| Agentic tool loop | Yes (`maxTurns`) | Yes | Yes | Yes | N/A | Yes (`max=20` + hash-loop detector) |
| Loop detection beyond counter | No (per [issue #4277](https://github.com/anthropics/claude-code/issues/4277)) | Unclear | Unclear | Unclear | N/A | Yes (3× hash match) |
| Local LLM agentic | Limited | No | Yes (Ollama) | Yes (Ollama) | N/A | Yes (LM Studio first-class) |
| Persistent memory across sessions | Project memory | Project memory | None | None | Yes (cloud or local) | Yes (local SQLite + trust tiers) |
| Semantic memory recall | Embedded | Embedded (cloud) | Limited | None | Yes (cloud embed) | Yes (local nomic-embed) |
| Memory conflict detection | No | No | No | No | DELETE op (latest wins) | Yes (annotate + reciprocal) |
| Delta-aware extraction | No | No | No | No | LLM-driven ADD/UPDATE | Yes (prompt-driven, local) |
| Figma integration | Via MCP | Via MCP | Via MCP | No | N/A | Native (local LLM, 4 tools) |
| Privacy gates (consent + workdir) | No | No | No | No | No | Yes (existing) |
| Hallucination check on outputs | No | No | No | No | No | Yes (Berry, existing) |

**Net positioning:** Relay v0.2 is the only tool combining (a) local LLM agentic loops, (b) persistent + conflict-aware memory, (c) privacy gates, (d) hallucination verification — all offline.

---

## Sources

### HIGH confidence
- LM Studio Tool Use API — https://lmstudio.ai/docs/developer/openai-compat/tools
- LM Studio API Changelog — https://lmstudio.ai/docs/developer/api-changelog
- LM Studio Embeddings — https://lmstudio.ai/docs/python/embedding
- nomic-embed-text-v1.5 on HF — https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
- Nomic Embeddings Guide — https://docs.nomic.ai/atlas/embeddings-and-retrieval/generate-embeddings
- Claude Code agent loop docs — https://code.claude.com/docs/en/agent-sdk/agent-loop
- Claude Code Loop Detection issue #4277 — https://github.com/anthropics/claude-code/issues/4277
- Figma MCP Server announcement — https://www.figma.com/blog/introducing-figma-mcp-server/
- Figma Canvas + Agents — https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/
- Figma + Claude Code (Composio) — https://composio.dev/toolkits/figma/framework/claude-code
- Relay codebase: `src/workers/lmstudio.ts`, `src/workers/codex.ts`, `src/memory/memory-engine.ts:195`, `src/memory/memory-store.ts`, `src/memory/db-migrations.ts`, `src/memory/auto-extract-runner.ts`
- DELTA-MEM-CONFLICT.md — full algorithmic spec for Feature 3
- LMSTUDIO-TOOL-API.md — full LM Studio tool-call spec for Feature 1
- ROADMAP.md §§1-7 — Relay v0.2 milestone scope

### MEDIUM confidence
- Common Agent Failure Modes — https://agentwiki.org/common_agent_failure_modes
- Per-turn limit regression (Claude Code) — https://github.com/anthropics/claude-code/issues/33969
- SQLite + embeddings (sqlite-vec context) — https://www.danielcorin.com/til/sqlite/embeddings-with-sqlite-vector/
- Figma → React via LLM — https://medium.com/@arunrham93/figma-design-to-react-code-an-automated-frontend-generation-using-llm-580a183af58a
- Community Figma MCP Server pattern — https://dev.to/om_shree_0709/bridging-llms-and-design-systems-via-mcp-implementing-a-community-figma-mcp-server-for-generative-2ig2

### Codebase anchors
- `src/workers/lmstudio.ts` — single-shot baseline (Feature 1 extends to agentic sibling file)
- `src/workers/codex.ts:DISABLED_CODEX_MCP_LABELS` — Figma was explicitly disabled here (Feature 5 unblocks via local runner)
- `src/memory/memory-engine.ts:59` (`computeContentScore`) — word-overlap (Feature 2 adds cosine component)
- `src/memory/memory-engine.ts:195` (`budgetedRecall`) — Feature 3 pairwise pass insertion point
- `src/memory/auto-extract-runner.ts` — Feature 4 prompt + existing-memory injection
- `src/memory/db-migrations.ts:88` — PRAGMA-guarded ALTER pattern reused by Features 2 + 3

---
*Feature research for: Relay v0.2 — agentic + semantic memory + Figma*
*Researched: 2026-05-18*
