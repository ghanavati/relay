# Changelog — v0.2 Draft Skeleton

> **STATUS:** DRAFT. Do NOT promote to `CHANGELOG.md` until all v0.2 phases (1–7) have shipped and `/gsd-complete-milestone` runs. Executor agents fill bullets in-place as each phase lands.
>
> Format: [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/). SemVer per [semver.org](https://semver.org/spec/v2.0.0.html).
>
> Last updated: 2026-05-20 (skeleton)

---

## [0.2.0] — YYYY-MM-DD

Agentic capability + memory upgrades on top of the v0.1.2 baseline (972 tests passing). Schema migrated to v2 behind a versioned migrator with an online `.v1-backup`, the local LM Studio runner gains a tool-calling loop, embeddings light up the recall path, conflict detection annotates contradictions at recall time, auto-extract diffs against existing memories before extracting, and Figma REST tools ride on the new agentic runner.

### Added

#### Phase 1 — Schema Cleanup

- [ ] TODO: `schema_version` table added; `getDb()` applies migrations idempotently and stamps the applied version.
- [ ] TODO: 11 orphan tables dropped behind v2 migration (`continuity_objects`, `recipes`, `sign_offs`, `sign_off_amendments`, `operator_annotations`, `proxy_requests`, `jobs`, `tasks`, `task_deps`, `job_events`, `verifications`). FK drop order respected.
- [ ] TODO: Pre-migration online `.v1-backup` created in the relay store directory before any DROP. Opt-out via `RELAY_SKIP_V2_BACKUP=1`. Fail-loud on backup error.
- [ ] TODO: `relay doctor` gains a `schema_version` probe — reports `ok` | `missing` | `failed`.
- [ ] TODO: `relay info` surfaces `schema_version=2` once migrated.

#### Phase 2 — Budget Verification (no new surface; integration verification)

- [ ] TODO: Confirm the shipped `cmd-budget.ts` v0.2 surface (`--provider`, `--workdir`, `--period`, scope CHECK constraint) survives the Phase 1 migration on v0.1.2 databases without schema drift.
- [ ] TODO: All previously-passing budget tests (`budget-store.test.ts`, `cmd-budget.test.ts`) green after Phase 1 migration applies to fixtures.

#### Phase 3 — Agentic LM Studio Runner

- [ ] TODO: New `lmstudio-agentic` provider with multi-iteration tool-call → execute → append loop. Worker results carry `tool_call_count` and `iterations`.
- [ ] TODO: New `ExecutionModel = "tool_loop"` variant added to `src/workers/runner.ts` union.
- [ ] TODO: Loop-detection (3 consecutive identical tool-call hashes → `LOOP_DETECTED` abort) and iteration cap (max 20).
- [ ] TODO: `shell_exec` (alias `bash`) tool with cwd-clamp against the task workdir and 32KB stdout truncation.
- [ ] TODO: LFM2 JSON-format nudge auto-injected into the system prompt when the model name matches `liquid/lfm2-*` (avoids Pythonic tool calls).
- [ ] TODO: `relay parallel` accepts `--provider lmstudio-agentic` for any task in the spec.

#### Phase 4 — Embeddings Wire-Up

- [ ] TODO: Recall path embeds the query and feeds cosine similarities into `scoreMemoryDetailed()`. Word-overlap remains the fallback for rows with NULL `embedding_blob`.
- [ ] TODO: `relay memory remember` returns sync; `embedding_blob` is populated by a lazy UPDATE after INSERT.
- [ ] TODO: Graceful degradation when LM Studio is offline — recall continues on word-overlap, stderr-loud warning, no NULL crashes.
- [ ] TODO: `relay memory why <id>` shows `ScoreComponents.content` reflecting semantic similarity (when present) via `opts.semanticSimilarity` trace.

#### Phase 5 — Conflict Detection

- [ ] TODO: Write-time conflict detection populates reciprocal `conflicts_with_json` IDs (same transaction, mutual update).
- [ ] TODO: Recall annotates the lower-trust side with `⚠ CONFLICTS WITH #N` (default policy `ANNOTATE_BOTH`; pinned never dropped).
- [ ] TODO: Cosine-similarity gate (≥ 0.7) prevents paraphrase false positives.
- [ ] TODO: Conflict scope clamped to a single workdir — cross-workdir conflicts never trigger.
- [ ] TODO: `budgetedRecall()` pairwise pass capped at K=32 to bound latency.

#### Phase 6 — Delta Extraction

- [ ] TODO: Auto-extract prepends an "Existing known patterns" block (top-50, 2KB budget) to the LM Studio prompt before the transcript window.
- [ ] TODO: New `memory_source = 'delta-contradiction'` for contradictions surfaced by the extractor — feeds the Phase 5 conflict pipeline.
- [ ] TODO: `MemoryStore.getCandidates(workdir, limit=50, tokenBudget=2000)` invoked exactly once per auto-extract run.
- [ ] TODO: Empty-workdir backward compatibility — when zero existing memories, the prompt collapses to the pre-DELTA structure (no spurious LLM confusion).

#### Phase 7 — Figma REST Tools

- [ ] TODO: `figma_list_layers` tool registered into the agentic runner — `GET /v1/files/{key}/nodes` with `X-Figma-Token` header.
- [ ] TODO: `figma_update_token` tool — `POST /v1/files/{key}/variables` (Enterprise-only; clear 403 surfaced through the loop on lower tiers).
- [ ] TODO: Graceful absence when `FIGMA_API_TOKEN` is unset — tools NOT registered, no startup error, no tool exposed to the model.
- [ ] TODO: 429 backoff respects `Retry-After`; single retry then hard error (no silent infinite loop, no PAT leak in retry logs).
- [ ] TODO: `figma_get_selection` and `figma_create_component` declaratively deferred to v0.3 (require Plugin API WebSocket bridge) — surfaced in `--help` and `relay doctor`.

#### Budget command v0.2 (carry-over from v0.1 known limitations)

- [ ] TODO: `relay budget show --provider <name> --workdir <path> --period <window>` returns scoped usage rows. (Was listed as deferred under v0.1.0 "Known limitations".)

### Changed

- [ ] TODO: `src/workers/lmstudio.ts` remains text-only (single-shot). New `src/workers/lmstudio-agentic.ts` is added as a **separate** provider — neither replaces nor degrades the existing path.
- [ ] TODO: Dispatcher in `cli.ts` routes `--provider lmstudio-agentic` to the new ExecutionModel `"tool_loop"` runner.
- [ ] TODO: `relay info` reports `schema_version` and embedding-client reachability alongside existing diagnostics.
- [ ] TODO: Recall scoring path now consumes the `similarities` map from the caller layer (`cmd-memory-recall.ts`, `src/tools/memory_search.ts`); `memory-engine.ts` purity preserved (no new imports beyond `./types` + `./constants`).

### Fixed

- [ ] TODO: Dispatcher bug in `cli.ts:649` (see Phase 3 plan — exact line drifted; verify on fix). Re-verify line number against shipped code before promoting this entry.
- [ ] TODO: (placeholder — fill any incidental bugs surfaced during phases 1–7 here)

### Security

- [ ] TODO: `memory-engine.ts` purity enforcement gate — new CI lint rejects any import outside `./types` and `./constants`. Prevents recall/scoring from accidentally pulling I/O.
- [ ] TODO: Figma PAT scrubbing — `FIGMA_API_TOKEN` and `X-Figma-Token` header values redacted from all relay logs (auto-extract, run-events, retry logs).
- [ ] TODO: `shell_exec` cwd-clamp enforced at the worker boundary — model cannot escape the task workdir even via `cd ../` or absolute paths.
- [ ] TODO: `figma_update_token` requires Enterprise scope — call rejected pre-flight on lower plans with an explicit 403 surface (avoids silent failures and credential probing).
- [ ] TODO: Pre-migration `.v1-backup` is `chmod 600` consistent with `~/.relay/secrets` posture.

### Migration notes from 0.1.2

- [ ] TODO: First v0.2 launch auto-migrates v0.1.2 databases to schema v2 and writes `.v1-backup` in the relay store directory before any DROP.
- [ ] TODO: Set `RELAY_SKIP_V2_BACKUP=1` to skip backup creation (not recommended; intended for CI / disposable fixtures).
- [ ] TODO: `relay doctor` post-upgrade should report `schema_version=ok`. If `missing` or `failed`, restore from `.v1-backup` and file an issue.
- [ ] TODO: 11 orphan tables (listed under Phase 1) are removed. No command in v0.1.x read or wrote them, so user data is unaffected.
- [ ] TODO: Agentic LM Studio is opt-in via `--provider lmstudio-agentic`. The existing `--provider lmstudio` text-only path is unchanged.
- [ ] TODO: Embeddings backfill is lazy — existing memories acquire `embedding_blob` on next recall or via the optional `relay memory reindex` one-shot. No forced backfill at upgrade time.
- [ ] TODO: Figma tools require `FIGMA_API_TOKEN` env. Without it, no Figma tool is registered (graceful absence — not an error).

### Tests

- [ ] TODO: Final pass/fail count once Phase 7 lands. Baseline target: 972/972 + new tests per phase.

---

[0.2.0]: https://github.com/ghanavati/relay/compare/v0.1.2...v0.2.0
