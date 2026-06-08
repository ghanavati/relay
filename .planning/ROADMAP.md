# Roadmap: Relay

## Overview

Milestone v0.2 layers agentic capability and memory upgrades onto Relay's v0.1.2 baseline (972 tests passing). The journey: clean the schema (drop 11 orphan tables behind a versioned migration), verify the partially-shipped budget command chains correctly with the new `schema_version` table, build the agentic LM Studio tool-call loop, wire the already-shipped embedding client into memory scoring, layer conflict detection on top of stronger semantic ranking, teach auto-extract to diff against existing memories, then ship Figma REST tools that ride on the agentic runner. Sequence ordering follows research/SUMMARY.md §3 — embeddings precede conflict detection so conflict thresholds calibrate against cosine similarity, not Jaccard.

## Milestones

- [x] **v0.1.0** — Initial release (shipped 2026-05-02)
- [x] **v0.1.1** — Wave 4a patch (shipped 2026-05-10)
- [x] **v0.1.2** — Codex wave-4 audit fixes (shipped 2026-05-11)
- [ ] **v0.2** — Agentic capability + memory upgrades (Phases 1-7, in progress)
- [ ] **v0.3** — Universal LLM control layer + Command Central (Phase 8, planned)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Schema Cleanup** - Drop 11 orphan tables behind a versioned migration with online backup
- [ ] **Phase 2: Budget Verification** - Verify shipped v0.2 budget store chains correctly with schema_version migration
- [ ] **Phase 3: Agentic LM Studio Runner** - Local LLM gains tool-calling loop with loop-detection and iteration cap
- [ ] **Phase 4: Embeddings Wire-Up** - Wire shipped embedding client into recall scoring without breaking sync semantics
- [ ] **Phase 5: Conflict Detection** - Write-time conflict detection with annotation at recall, cosine gate against false positives
- [ ] **Phase 6: Delta Extraction** - Auto-extract diffs against existing memories, surfacing contradictions instead of re-extracting
- [ ] **Phase 7: Figma REST Tools** - Local agentic runner can list Figma layers and update tokens via REST API
- [ ] **Phase 8: Universal LLM Control + Command Central** - Bidirectional session bus plus a terminal-native operator console so humans and permitted models can inspect, message, grant, revoke, and coordinate supported LLM sessions through the same Relay policy path

## Phase Details

### Phase 1: Schema Cleanup
**Goal**: Migrate v0.1.2 databases to a clean v0.2 schema with versioned migrations and pre-migration backup, removing 11 orphan tables that no command reads or writes.
**Depends on**: Nothing (first phase; prerequisite for all downstream phases per research §5 dependency graph)
**Requirements**: SCHEMA-01, SCHEMA-02, SCHEMA-03
**Success Criteria** (what must be TRUE):
  1. User can launch v0.2 against a v0.1.2 database and `relay info` reports `schema_version=2` with all pre-existing memories intact (zero data loss)
  2. After first v0.2 launch, `sqlite3 .relay/relay.db ".tables"` shows the 11 orphan tables removed (`continuity_objects`, `recipes`, `sign_offs`, `sign_off_amendments`, `operator_annotations`, `proxy_requests`, `jobs`, `tasks`, `task_deps`, `job_events`, `verifications`) and FK drop order respected (no constraint errors)
  3. User finds a `.v1-backup` file in the relay store directory after first v0.2 launch; setting `RELAY_SKIP_V2_BACKUP=1` skips backup creation
  4. User can run `relay doctor` and see a `schema_version` check that confirms applied version matches expected
**Plans**: TBD

### Phase 2: Budget Verification
**Goal**: Confirm the already-shipped v0.2 budget store, scope CHECK, and `cmd-budget` flag surface chain correctly with the new `schema_version` table from Phase 1, and that all 972+ existing tests stay green after the schema migration applies.
**Depends on**: Phase 1
**Requirements**: (none — BudgetStore.getUsage, scope CHECK, and cmd-budget v0.2 implementation already shipped via commits 4d21e99, b7f5083, 1728686, d4804c6, 00ad578; this phase verifies integration with Phase 1's migration chain rather than introducing new REQ-IDs)
**Success Criteria** (what must be TRUE):
  1. User can run `relay budget show --provider lmstudio --workdir /path` against a v0.2-migrated database and see scoped usage rows (provider/workdir/period scoping) returned without schema errors
  2. The shipped budget scope CHECK constraint (`scope IN ('global','provider','workdir')`) survives the Phase 1 migration intact — INSERTs with new scope values succeed
  3. All previously-passing budget tests (`budget-store.test.ts`, `cmd-budget.test.ts`) remain green after Phase 1 migration applies to test fixtures
  4. `relay doctor` reports no budget-related schema drift between expected v0.2 schema and live database
**Plans**: TBD

### Phase 3: Agentic LM Studio Runner
**Goal**: Local LM Studio models gain a tool-calling agentic loop, becoming first-class workers that can drive multi-step tool-using tasks (Figma, shell, future in-process handlers) without falling back to Codex or external APIs.
**Depends on**: Phase 1 (clean schema baseline)
**Requirements**: AGENTIC-01, AGENTIC-02, AGENTIC-03, AGENTIC-04, AGENTIC-05, AGENTIC-06
**Success Criteria** (what must be TRUE):
  1. User can dispatch a task with `relay run --provider lmstudio-agentic --task "ls and summarize"` and observe a multi-iteration tool-call → execute → append loop ending with a final answer; `WorkerResult.tool_call_count` and `iterations` populated
  2. User running a deliberately tight loop (model emits same `shell_exec` call repeatedly) sees the worker abort after 3 consecutive identical hashes with a clear `LOOP_DETECTED` status, not burn budget to max iterations (20)
  3. User running `relay run` with the agentic worker against a model whose name matches `liquid/lfm2-*` receives JSON-format tool calls (not Pythonic), proven by the LFM2 nudge being injected into the system prompt
  4. User attempting `shell_exec` (or alias `bash`) outside the task workdir observes the call rejected with cwd-clamp error and 32KB truncation applied to all stdout
  5. `relay parallel` accepts `--provider lmstudio-agentic` for any task in the spec and the new ExecutionModel `"tool_loop"` appears in `src/workers/runner.ts` union
**Plans**: TBD

### Phase 4: Embeddings Wire-Up
**Goal**: The already-shipped embedding client (`src/memory/embedding-client.ts`, 8.3K, 18 tests) becomes active in the recall path — queries get embedded, cosine similarities feed the scorer, and word-overlap remains the fallback for rows without `embedding_blob`.
**Depends on**: Phase 1 (schema_version + embedding_blob column established)
**Requirements**: EMBED-01, EMBED-02, EMBED-03, EMBED-04, EMBED-05
**Success Criteria** (what must be TRUE):
  1. User writes 5 memories about CSS naming conventions, queries "naming conventions for stylesheets" via `relay memory search`, and observes "prefer kebab-case for CSS" recalled in top results despite zero word overlap with the query
  2. User running `relay memory remember "..."` returns sync without waiting for embedding generation; subsequent `relay memory get <id>` shows `embedding_blob` populated within ~1s (lazy UPDATE after sync INSERT)
  3. User with LM Studio offline observes recall still works (word-overlap fallback) — `embedding_blob` rows remain NULL but `scoreMemoryDetailed()` degrades gracefully; stderr-loud warning surfaces
  4. User can call `relay memory why <id>` and see `ScoreComponents.content` reflecting the semantic similarity value (when present) rather than word-overlap, with `opts.semanticSimilarity` traced in the explanation
  5. `memory-engine.ts` purity preserved: no new imports beyond `./types` and `./constants`; similarities map computed at the caller layer (`cmd-memory-recall.ts`, `src/tools/memory_search.ts`) and passed into `budgetedRecall()`
**Plans**: TBD

### Phase 5: Conflict Detection
**Goal**: Memories that directly contradict each other get flagged at write time with reciprocal `conflicts_with_json` IDs, and at recall time the conflict is surfaced to the model via annotation (`ANNOTATE_BOTH` default) so it sees both sides with explicit warning.
**Depends on**: Phase 4 (cosine similarity needed for the false-positive gate per CONFLICT-04)
**Requirements**: CONFLICT-01, CONFLICT-02, CONFLICT-03, CONFLICT-04, CONFLICT-05
**Success Criteria** (what must be TRUE):
  1. User writes memory A ("use kebab-case for CSS classes") then memory B ("prefer camelCase for all identifiers") in the same workdir; `relay memory get B` shows `conflicts_with_json` listing A's ID, and `relay memory get A` retroactively lists B's ID (mutual, same transaction)
  2. User queries `relay memory search "css class naming"` and observes both A and B recalled, with the lower-trust entry annotated as `⚠ CONFLICTS WITH #N` rather than silently dropped (ANNOTATE_BOTH default, pinned never dropped)
  3. User writes two paraphrased memories with high tag overlap but cosine similarity ≥ 0.7 (semantic paraphrases of the same lesson) and observes NO conflict flagged — cosine gate prevents the false positive
  4. User running recall across two different workdirs observes conflict detection scoped to single workdir only; cross-workdir conflicts never trigger (workdir leak prevention)
  5. `budgetedRecall()` capped at K=32 per recall for the pairwise conflict pass — latency stays bounded even with large candidate sets
**Plans**: TBD

### Phase 6: Delta Extraction
**Goal**: Auto-extract sees the workdir's existing memories before processing a new transcript, and the T10 prompt asks the model to extract only what's new, contradictory, or refined — suppressing re-extraction of known patterns and feeding contradictions into the Phase 5 conflict system.
**Depends on**: Phase 5 (DELTA-03 `'delta-contradiction'` source value propagates into CONFLICT flow)
**Requirements**: DELTA-01, DELTA-02, DELTA-03, DELTA-04
**Success Criteria** (what must be TRUE):
  1. User triggers auto-extract on a workdir with 50 existing memories; the LM Studio request includes an "Existing known patterns" block followed by the transcript window, and the resulting extraction set contains zero re-extracted duplicates of known patterns
  2. User observes contradictions surfaced as memories with `memory_source = 'delta-contradiction'`, which propagate into `conflicts_with_json` on the new memory via the Phase 5 detection path
  3. User running auto-extract on a clean workdir (zero existing memories) observes structurally-equivalent prompt to the current (pre-DELTA) baseline — the empty Existing block collapses with no spurious LLM confusion (backward compat verified)
  4. `MemoryStore.getCandidates(workdir, limit=50, tokenBudget=2000)` invoked exactly once per auto-extract run before `buildPrompt()` — fetching path observable via existing instrumentation
**Plans**: TBD

### Phase 7: Figma REST Tools
**Goal**: The Phase 3 agentic runner gains two Figma tools (`figma_list_layers`, `figma_update_token`) that hit Figma's REST API directly using the user's PAT — enabling local LLMs to read layer trees and write design tokens without API cost. The two plugin-bridge tools are explicitly deferred to v0.3.
**Depends on**: Phase 3 (tools register into the agentic runner)
**Requirements**: FIGMA-01, FIGMA-02, FIGMA-03, FIGMA-04, FIGMA-05
**Success Criteria** (what must be TRUE):
  1. User with `FIGMA_API_TOKEN` env set runs `relay run --provider lmstudio-agentic --task "list layers in file ABC123"` and observes the model invoking `figma_list_layers` which hits `GET /v1/files/{key}/nodes` with `X-Figma-Token` header and returns the layer tree
  2. User without `FIGMA_API_TOKEN` env set runs the same command and observes Figma tools NOT registered in the runner — no startup error, no tool exposed to model (graceful absence)
  3. User on a non-Enterprise Figma plan calling `figma_update_token` receives a clear 403 error message surfaced through the agentic loop (not a generic crash); user on Enterprise plan completes the token write to `POST /v1/files/{key}/variables`
  4. User hitting Figma's rate limit (429) observes exponential backoff respecting `Retry-After` header before retry — single retry attempt then hard error if still throttled (no silent infinite loop, no PAT leak in retry logs)
  5. User can confirm via `--help` or `relay doctor` that `figma_get_selection` and `figma_create_component` are explicitly deferred to v0.3 (require Plugin API WebSocket bridge — declaratively absent, not silently broken)
**Plans**: TBD

### Phase 8: Universal LLM Control + Command Central
**Goal**: Relay becomes a bidirectional control fabric with a real command center: every supported LLM surface can register as a session, expose truthful capabilities, exchange messages through Relay, and be operated by humans or permitted models through one audited broker-backed surface.
**Depends on**: Phase 3 (Relay-native tool-loop worker), Phase 6 (transcript/memory distillation patterns)
**Requirements**: CONTROL-01, CONTROL-02, CONTROL-03, CONTROL-04, CONTROL-05, CONTROL-06, CONTROL-07, CONTROL-08, CONTROL-09, CONTROL-10, CONTROL-11, CONTROL-12, CONTROL-13, CONTROL-14, CONTROL-15, CONTROL-16, CONTROL-17
**Success Criteria** (what must be TRUE):
  1. User can run `relay session list / inspect / tail / send` against registered Claude Code, Codex, LM Studio, OpenRouter, Anthropic, and fake test sessions, with adapter capabilities shown explicitly.
  2. A Relay-owned LM Studio agentic session can use `relay_session_send` to message another session, and that target can reply through the same broker path.
  3. Claude Code ambient sessions register via hooks and receive queued messages at supported hook boundaries without regressing SessionStart memory injection or SessionEnd auto-extract.
  4. Codex integration reports conservative capabilities and never claims live control unless a Relay-owned process or verified resume/send path is active.
  5. Unauthorized or looping LLM-to-LLM sends are blocked by grants, TTLs, budgets, and repeated-content detection, with every decision visible in SQLite audit events.
  6. `relay tui` is Command Central: session rail, capability/state badges, live event pane, inbox, approval queue, audit rail, and command palette backed by the same broker as CLI/tools.
  7. A permitted model can request Command Central-equivalent operations through Relay tools, and the UI shows requested, approved, denied, and executed model actions without allowing self-escalation.
  8. Command Central stays fast under active sessions: bounded reads, cancellable refreshes, and no unbounded work on the Ink render path.
**Plans**: `.planning/phases/08-universal-llm-control/08-01-PLAN.md`, `.planning/phases/08-universal-llm-control/08-02-PLAN.md`, `.planning/phases/08-universal-llm-control/08-03-PLAN.md`, `.planning/phases/08-universal-llm-control/08-04-PLAN.md`, `.planning/phases/08-universal-llm-control/08-05-PLAN.md`, `.planning/phases/08-universal-llm-control/08-06-PLAN.md`, `.planning/phases/08-universal-llm-control/08-07-PLAN.md`, `.planning/phases/08-universal-llm-control/08-08-PLAN.md`, `.planning/phases/08-universal-llm-control/08-09-PLAN.md`

## Progress

**Execution Order:**
Phases execute in numeric order within the active milestone. Phase 8 is the first planned v0.3 phase and starts after the v0.2 Phase 1-7 chain closes.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Schema Cleanup | 0/TBD | Not started | - |
| 2. Budget Verification | 0/TBD | Not started | - |
| 3. Agentic LM Studio Runner | 0/TBD | Not started | - |
| 4. Embeddings Wire-Up | 0/TBD | Not started | - |
| 5. Conflict Detection | 0/TBD | Not started | - |
| 6. Delta Extraction | 0/TBD | Not started | - |
| 7. Figma REST Tools | 0/TBD | Not started | - |
| 8. Universal LLM Control + Command Central | 9/9 | Implemented (branch, pending Codex review + merge) |  |

---

Last updated: 2026-06-07 (split v0.3 Phase 8 into subagent-ready broker, adapter, CLI, and Command Central work packets)
