# Requirements — Milestone v0.2

## v0.2 Requirements

Active requirements scoped to this milestone. REQ-IDs use category prefix + number.

### Schema (SCHEMA)

- [ ] **SCHEMA-01**: User can run any v0.1 → v0.2 DB migration without data loss; `schema_version` table tracks applied versions; DROP migrations execute only when version bump justifies them
- [ ] **SCHEMA-02**: After v2 migration, 11 orphan tables removed (`continuity_objects`, `recipes`, `sign_offs`, `sign_off_amendments`, `operator_annotations`, `proxy_requests`, `jobs`, `tasks`, `task_deps`, `job_events`, `verifications`) honoring FK drop order: task_deps→tasks→jobs→job_events; sign_off triggers→sign_off_amendments→sign_offs; recipes→continuity_objects
- [ ] **SCHEMA-03**: `.v1-backup` written via better-sqlite3 online backup API before v2 migration runs (opt-out via `RELAY_SKIP_V2_BACKUP=1`)

### Agentic local LLM worker (AGENTIC)

- [ ] **AGENTIC-01**: User can dispatch task to local LM Studio model with `tools[]` array; new worker `src/workers/lmstudio-agentic.ts` runs the tool-call → execute → append → loop until model emits final answer or max iterations hit
- [ ] **AGENTIC-02**: Max iterations = 20; hash-based loop detector (hash of `name+args`, abort on 3 consecutive matches) prevents tight loops
- [ ] **AGENTIC-03**: `shell_exec` (alias `bash`) is the reserved built-in tool name; cwd clamped to task workdir; 32KB stdout truncation; never executes outside workdir
- [ ] **AGENTIC-04**: Dispatch wired in `src/cli/cmd-run.ts` and `src/cli/cmd-parallel.ts`; new provider `lmstudio-agentic` selectable via `--provider lmstudio-agentic`
- [ ] **AGENTIC-05**: WorkerResult includes `tool_call_count` and `iterations`; new ExecutionModel `"tool_loop"` added to `src/workers/runner.ts:5` union
- [ ] **AGENTIC-06**: LFM2 system-prompt nudge ensures JSON tool-call output (not default Pythonic); injected when model name matches `liquid/lfm2-*`

### Semantic embeddings wiring (EMBED)

- [ ] **EMBED-01**: `MemoryStore.remember()` triggers lazy embedding generation (async UPDATE after sync INSERT); never blocks the write path; failure logged but not thrown
- [ ] **EMBED-02**: `scoreMemoryDetailed()` accepts optional 4th param `opts?: { semanticSimilarity?: number }` and uses it as the content score component when present; falls back to word-overlap when null
- [ ] **EMBED-03**: `budgetedRecall()` accepts optional `similarities?: ReadonlyMap<string, number>` pre-computed from query embedding; passes through to scorer
- [ ] **EMBED-04**: At recall time, `cmd-memory-recall.ts` + `src/tools/memory_search.ts` call new async `computeSemanticSimilarities()` helper before `getCandidates()` (preserves sync `better-sqlite3` semantics)
- [ ] **EMBED-05**: Integration test — write 5 memories about CSS naming, query "naming conventions for stylesheets" recalls "prefer kebab-case for CSS" despite zero word overlap

### Conflict detection (CONFLICT)

- [ ] **CONFLICT-01**: `conflicts_with_json TEXT DEFAULT '[]'` column added via PRAGMA-guarded migration on memories table
- [ ] **CONFLICT-02**: `MemoryStore.remember()` runs candidate-conflict check at write time: tag_jaccard > 0.5 + content_jaccard < 0.3 + ≥2 shared tags → store mutual conflict IDs
- [ ] **CONFLICT-03**: `budgetedRecall()` runs pairwise pass after sort, before budget loop; `ANNOTATE_BOTH` default (inject loser with `⚠ CONFLICTS WITH #N` rather than drop); precedence trust_level → score → recency; K capped at 32 per recall
- [ ] **CONFLICT-04**: When both memories have non-null `embedding_blob` (post EMBED), require cosine < 0.7 to confirm conflict (false-positive gate)
- [ ] **CONFLICT-05**: Workdir-scoped only; never cross-workdir conflict-detect

### Delta extraction (DELTA)

- [ ] **DELTA-01**: `auto-extract-runner.ts:buildPrompt()` accepts optional `existingMemories: Memory[]` arg; T10 template injects "Existing known patterns:\n[list]\n\nNew transcript:\n[window]\n\nExtract only what the transcript ADDS, CONTRADICTS, or REFINES…"
- [ ] **DELTA-02**: `cmd-memory-auto-extract.ts` fetches existing memories via `MemoryStore.getCandidates(workdir, limit=50, tokenBudget=2000)` before invoking buildPrompt
- [ ] **DELTA-03**: New `MemorySource` enum value `'delta-contradiction'` for entries surfaced as contradictions; propagates to CONFLICT flow once both phases ship
- [ ] **DELTA-04**: Backward compat — `buildPrompt(transcript, [])` produces structurally-equivalent prompt to current (empty Existing block collapses)

### Figma tools (FIGMA)

- [ ] **FIGMA-01**: `figma_list_layers(file_key, page_id?)` tool registered when `FIGMA_API_TOKEN` env set; calls `GET /v1/files/{key}/nodes` with `X-Figma-Token` header; returns layer tree JSON
- [ ] **FIGMA-02**: `figma_update_token(token_name, value, type, collection_id)` calls `POST /v1/files/{key}/variables`; gracefully handles 403 (Enterprise plan required)
- [ ] **FIGMA-03**: Tools registered into `lmstudio-agentic` worker ONLY when `FIGMA_API_TOKEN` env present; no startup error when absent
- [ ] **FIGMA-04**: Rate limit handling — exponential backoff on 429; respect `Retry-After` header
- [ ] **FIGMA-05**: Tools `figma_get_selection` and `figma_create_component` deferred to v0.3 (require Figma Plugin API bridge — WebSocket server + ~150 LoC plugin)

## Future Requirements (deferred to v0.3+)

- TUI visual layer (Ink) — history + live run progress + cost dashboard
- Skill packs (slim), `relay run --pipe`, `relay queue cron`, `relay watch <dir>`, brew formula
- Figma Plugin API bridge (get_selection, create_component) — WebSocket on port 9223
- LM Studio agentic streaming (currently stream:false for v0.2)
- In-process tool handlers (currently shell_exec only)

## Out of Scope

- Cloud-hosted memory store — local-first by design
- Multi-user / team features
- Web UI — TUI roadmap planned for v0.3
- API server — CLI + MCP server only
- Codex CLI dependency for execution — local agentic worker replaces it

## Traceability

Populated by gsd-roadmapper. Empty until ROADMAP.md is generated.

---

Last updated: 2026-05-19
