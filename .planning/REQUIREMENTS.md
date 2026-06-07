# Requirements — Milestone v0.2

## v0.2 Requirements

Active requirements scoped to this milestone. REQ-IDs use category prefix + number.

### Schema (SCHEMA)

- [x] **SCHEMA-01**: User can run any v0.1 → v0.2 DB migration without data loss; `schema_version` table tracks applied versions; DROP migrations execute only when version bump justifies them
- [x] **SCHEMA-02**: After v2 migration, 11 orphan tables removed (`continuity_objects`, `recipes`, `sign_offs`, `sign_off_amendments`, `operator_annotations`, `proxy_requests`, `jobs`, `tasks`, `task_deps`, `job_events`, `verifications`) honoring FK drop order: task_deps→tasks→jobs→job_events; sign_off triggers→sign_off_amendments→sign_offs; recipes→continuity_objects
- [x] **SCHEMA-03**: `.v1-backup` written via better-sqlite3 online backup API before v2 migration runs (opt-out via `RELAY_SKIP_V2_BACKUP=1`)

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

- Universal LLM control / session bus (CONTROL):
  - [ ] **CONTROL-01**: Relay can register and list LLM sessions across Claude Code, Codex, LM Studio, OpenRouter, Anthropic, and fake test adapters with explicit capability reporting.
  - [ ] **CONTROL-02**: Relay can inspect and tail session events from the central SQLite event store.
  - [ ] **CONTROL-03**: Relay can send a human-authored message to any registered target session when that target adapter reports a delivery capability.
  - [ ] **CONTROL-04**: LLM-initiated cross-session sends are denied by default and require explicit grants with TTL and message budget.
  - [ ] **CONTROL-05**: Relay exposes LLM-facing control tools (`relay_session_list`, `relay_session_send`, `relay_inbox_read`, `relay_inbox_ack`) to agentic workers and MCP-capable frontends.
  - [ ] **CONTROL-06**: Claude Code sessions register through hooks and receive queued messages through SessionStart/UserPromptSubmit context injection without breaking existing memory hooks.
  - [ ] **CONTROL-07**: LM Studio agentic sessions are Relay-native control sessions and can perform bidirectional send/receive through in-process tool handlers.
  - [ ] **CONTROL-08**: Codex integration is capability-discovered and conservative; it must not claim live control unless Relay owns the process or a verified resume/send path exists.
  - [ ] **CONTROL-09**: OpenRouter and Anthropic direct API sessions are transcript-backed Relay sessions with explicit non-live semantics.
  - [ ] **CONTROL-10**: Cross-session loops are bounded by repeated-content detection, grant budgets, TTLs, and audit-visible blocked events.
  - [ ] **CONTROL-11**: Relay exposes a shared `ControlSnapshot` read model consumed by `relay tui`, `relay tui --json`, and tests; the TUI must not add independent SQL paths.
  - [ ] **CONTROL-12**: `relay tui` becomes Command Central: terminal-native session roster, state rollups, capability badges, live event pane, inbox, grants queue, audit rail, and status/cost strip.
  - [ ] **CONTROL-13**: Every Command Central action (`send`, `tail`, `inspect`, `grant`, `revoke`, `pause`, `resume`, `delegate`) routes through the same control broker path as CLI and LLM tools.
  - [ ] **CONTROL-14**: LLM-driven Command Central operations are visible as first-class control events with caller session, requested action, approval state, outcome, and denial reason.
  - [ ] **CONTROL-15**: Models can request Command Central-equivalent actions through Relay tools, but cannot grant themselves new capabilities, raise budgets, bypass loop detection, or approve destructive actions without policy/human approval.
  - [ ] **CONTROL-16**: Command Central remains fast under active sessions: bounded reads, cancellable refreshes, no unbounded operations on the Ink render path, and graceful degradation when providers are offline.
  - [ ] **CONTROL-17**: Command Central follows a Herdr-inspired terminal control-surface shape: compact panes, workspace/session rail, agent state rollups, keyboard-first commands, and real operational controls rather than a marketing dashboard.
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

Generated by `gsd-roadmapper` on 2026-05-19. Maps every v0.2 REQ-ID to exactly one phase in `.planning/ROADMAP.md`.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCHEMA-01 | Phase 1 — Schema Cleanup | Complete |
| SCHEMA-02 | Phase 1 — Schema Cleanup | Complete |
| SCHEMA-03 | Phase 1 — Schema Cleanup | Complete |
| AGENTIC-01 | Phase 3 — Agentic LM Studio Runner | Pending |
| AGENTIC-02 | Phase 3 — Agentic LM Studio Runner | Pending |
| AGENTIC-03 | Phase 3 — Agentic LM Studio Runner | Pending |
| AGENTIC-04 | Phase 3 — Agentic LM Studio Runner | Pending |
| AGENTIC-05 | Phase 3 — Agentic LM Studio Runner | Pending |
| AGENTIC-06 | Phase 3 — Agentic LM Studio Runner | Pending |
| EMBED-01 | Phase 4 — Embeddings Wire-Up | Pending |
| EMBED-02 | Phase 4 — Embeddings Wire-Up | Pending |
| EMBED-03 | Phase 4 — Embeddings Wire-Up | Pending |
| EMBED-04 | Phase 4 — Embeddings Wire-Up | Pending |
| EMBED-05 | Phase 4 — Embeddings Wire-Up | Pending |
| CONFLICT-01 | Phase 5 — Conflict Detection | Pending |
| CONFLICT-02 | Phase 5 — Conflict Detection | Pending |
| CONFLICT-03 | Phase 5 — Conflict Detection | Pending |
| CONFLICT-04 | Phase 5 — Conflict Detection | Pending |
| CONFLICT-05 | Phase 5 — Conflict Detection | Pending |
| DELTA-01 | Phase 6 — Delta Extraction | Pending |
| DELTA-02 | Phase 6 — Delta Extraction | Pending |
| DELTA-03 | Phase 6 — Delta Extraction | Pending |
| DELTA-04 | Phase 6 — Delta Extraction | Pending |
| FIGMA-01 | Phase 7 — Figma REST Tools | Pending |
| FIGMA-02 | Phase 7 — Figma REST Tools | Pending |
| FIGMA-03 | Phase 7 — Figma REST Tools | Pending |
| FIGMA-04 | Phase 7 — Figma REST Tools | Pending |
| FIGMA-05 | Phase 7 — Figma REST Tools | Pending (declarative deferral — v0.3) |

**Coverage:** 28 / 28 v0.2 REQs mapped ✓ — no orphans, no duplicates.

**Note on Phase 2 (Budget Verification):** Zero v0.2 REQ-IDs assigned because the BudgetStore/cmd-budget v0.2 work was completed pre-roadmap via commits `4d21e99`, `b7f5083`, `1728686`, `d4804c6`, `00ad578`. Phase 2 verifies integration with Phase 1's `schema_version` migration chain rather than introducing new requirements.

---

Last updated: 2026-06-07 (expanded Phase 8 CONTROL requirements for Command Central and model-driven control)
