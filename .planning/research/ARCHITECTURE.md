# Architecture Research — Relay v0.2 Integration

**Domain:** TypeScript CLI extending an existing single-SQLite-file system with 5 features
**Researched:** 2026-05-18
**Confidence:** HIGH (direct read of existing src/ + 5 pre-existing scrap maps)

This document focuses on **integration points** — where each v0.2 feature attaches to v0.1.2's existing flow. Greenfield architecture is unchanged; see `docs/architecture.md` for the baseline.

---

## 1. Existing architecture (anchor)

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLI entry (src/cli.ts, 912 lines, monolithic dispatcher)            │
│  ─ argv → parseFlags → dispatch* → dynamic import('./cli/cmd-*.js')  │
├─────────────────────────────────────────────────────────────────────┤
│  Subcommands (src/cli/cmd-*.ts)                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐        │
│  │ cmd-run    │ │ cmd-memory │ │ cmd-context│ │ cmd-budget │        │
│  │ -parallel  │ │ -ops/-auto │ │ -emit      │ │ (stub)     │        │
│  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └────────────┘        │
├────────┴──────────────┴──────────────┴───────────────────────────────┤
│  Tools / domain (src/tools/, src/context/, src/memory/, src/workers/)│
│  ┌──────────────────────┐ ┌──────────────────────┐                   │
│  │  MemoryStore (1481)  │ │  WorkerRunner iface  │                   │
│  │  + memory-engine     │ │  ─ codex.ts (agentic │                   │
│  │  + db-migrations     │ │    subprocess)        │                   │
│  │  + auto-extract-     │ │  ─ lmstudio.ts        │                   │
│  │    runner            │ │  ─ openrouter.ts      │                   │
│  │  + consolidation     │ │  ─ anthropic.ts       │                   │
│  └──────────────────────┘ │  ─ generic-http-      │                   │
│                            │    runner.ts (base)   │                   │
│                            └──────────────────────┘                   │
├─────────────────────────────────────────────────────────────────────┤
│  Runtime (src/runtime/)                                              │
│  ┌──────────────────────┐ ┌──────────────────────┐                   │
│  │  store/db.ts         │ │  budget-store        │                   │
│  │  applySchema()       │ │  (per-model only,    │                   │
│  │  additive-only,      │ │   no provider/       │                   │
│  │  no schema_version   │ │   workdir scope yet) │                   │
│  └──────────────────────┘ └──────────────────────┘                   │
├─────────────────────────────────────────────────────────────────────┤
│  SQLite (~/.relay/relay.db) — single file, synchronous I/O           │
└─────────────────────────────────────────────────────────────────────┘
```

Key boundaries already enforced:
- **`memory-engine.ts` purity** — no I/O, no DB import; takes `Memory` in, returns scores out.
- **`WorkerRunner` contract** — `{ capabilities, run(task) }`; declared agentic flag is metadata, loop behavior lives in `run()`.
- **`generic-http-runner.ts`** — shared base for single-shot HTTP workers (LM Studio, OpenRouter); adds `contextPrefix` as `role:system`.
- **Dispatch is exhaustive** (`const exhaustive: never = args.provider`) — new providers must update 8 sites or reuse an existing provider name with branching.

---

## 2. Five-feature integration matrix

Each row: **what's new**, **what's modified**, **where it attaches**.

### Feature 1 — Schema cleanup + `schema_version` table

**Goal:** Drop 11 orphan tables, introduce monotonic schema versioning so future DROPs are gated.

**NEW files:**
- _None._ Pure DDL/migration change.

**MODIFIED files:**
| File | Rough lines | Change |
|---|---|---|
| `src/runtime/store/db.ts` | insert before line 15 (top of `DDL_STATEMENTS`) | Add `CREATE TABLE IF NOT EXISTS schema_version (...)` as first DDL |
| `src/runtime/store/db.ts` | after line 426 (`migrateAuthTables`) | Add `migrateDropOrphansV02(db)` call |
| `src/runtime/store/db.ts` | new function near line 426 | `migrateDropOrphansV02(db)` — gated by `SELECT version FROM schema_version WHERE version >= 2`; drops in FK order: `task_deps` → `tasks` → `jobs` → `job_events` → `sign_off_amendments` → triggers `:143-153` → `sign_offs` → `recipes` → `continuity_objects` → `proxy_requests` → `operator_annotations` → `verifications` |
| `src/runtime/store/db.ts` | lines 71-242 | Remove DDL for dropped tables from `DDL_STATEMENTS` |
| `src/runtime/store/db.ts` | lines 284-349, 402-404 | Remove orphan migration functions: `migrateTasksLeaseFields`, `migrateRunsVerificationStatus`, `migrateVerificationsConfidenceScore`, `migrateVerificationsSource`, `migrateProxyRequestsFullBody`, `purgeTaintedVerificationRecords` |
| `src/memory/db-migrations.ts` | top of file (constants) | Document version scheme; no functional change for memory tables |

**Integration point:** `applySchema()` at `db.ts:406-427` runs DDL_STATEMENTS first, then a fixed list of migration calls. New `migrateDropOrphansV02` slots in **after all other migrations** so the version check sees a fully-migrated DB before dropping.

**Data flow:**
- IN: `applySchema(db)` called once on `getDb()` cold init.
- OUT: `schema_version` table contains `(2, <ts>, 'v0.2 orphan cleanup')` after success; subsequent boots skip the DROP block.
- CONSUMES: none externally; `cmd-info.ts` already shows table counts and will naturally show fewer.

**Build order:** **Must ship first.** Every later feature adds a column (`embedding_json`, `conflicts_with_json`) — clean baseline avoids retrofitting versioning into an already-shipped column.

---

### Feature 2 — Agentic LM Studio runner (+ Figma integration)

**Goal:** Local LLM can drive a tool-calling loop. Figma tools are the first concrete use case.

**NEW files:**
- `src/workers/lmstudio-agentic.ts` — `LmStudioAgenticRunner` class, declares `capabilities = { agentic: true, execution_model: "tool_loop" } as const`. Tool loop: POST `/v1/chat/completions` with `tools[]`, parse `tool_calls[]`, execute, append `role:'tool'` messages, loop until terminal or cap.
- `src/workers/lmstudio-agentic.test.ts` — `node:test` + injected `fetchImpl` (mirror `codex.test.ts` injection pattern at lines 36-44).
- `src/workers/tools/figma.ts` (Phase 2 of feature) — Figma REST API tool handlers: `figma_create_component`, `figma_update_token`, `figma_get_selection`, `figma_list_layers`.
- `src/workers/tools/shell.ts` (Phase 1 of feature) — single `shell` tool via `execFile('/bin/sh', ['-c', cmd], { cwd })`. Workdir clamp upstream.

**MODIFIED files:**
| File | Rough lines | Change |
|---|---|---|
| `src/workers/runner.ts` | line 5 | Extend `ExecutionModel` union: `"relay-loop" \| "subprocess" \| "tool_loop"` |
| `src/workers/types.ts` | line 7-21 (`WorkerTask`) | Add optional `tools?: ToolDef[]` (OpenAI tool schema) |
| `src/workers/types.ts` | line 23-37 (`WorkerResult`) | Add optional `tool_call_count?: number`, `iterations?: number` |
| `src/cli/cmd-run.ts` | lines 72-74 | Branch within `provider === 'lmstudio'`: if `RELAY_LMSTUDIO_AGENTIC=1` OR `task.agentic === true`, instantiate `LmStudioAgenticRunner`; else current `LmStudioRunner` |
| `src/cli/cmd-parallel.ts` | lines 42-45 (`getRunner`) | Mirror same branch |
| `src/workers/codex.ts` | line 9 (`DISABLED_CODEX_MCP_LABELS`) | Remove `'figma'` from disabled set OR leave (no longer needed since Figma now routes via LM Studio agentic) |

**Integration point:** Two seams:
1. **Dispatch** — `cmd-run.ts:72-74` and `cmd-parallel.ts:42-45` choose runner based on env flag/task field. Reuse provider name `'lmstudio'` to avoid 8-site fan-out (see WORKERS-MAP §6 recommended approach).
2. **Tool execution** — `LmStudioAgenticRunner.run()` owns the loop in-process; calls `tools/{shell,figma}.ts` handlers keyed by `tool_calls[].function.name`.

**Data flow:**
- IN: `WorkerTask { task, contextPrefix, tools?, workdir, timeout_ms, model, ... }`.
- LOOP: POST `/v1/chat/completions` with accumulating `messages[]`; on `tool_calls[]` execute each, push `role:'tool'` result. Wall-clock `AbortController` per fetch, iteration cap (default 20). Sums `usage.{prompt,completion}_tokens` across iterations.
- OUT: `WorkerResult { status, output: final assistant content, iterations, tool_call_count, tool_use_blocks: tool_call_count, prompt_tokens, completion_tokens, ... }`.
- CONSUMES: `cmd-run.ts` writes to `runs` + `run_events` tables (unchanged); telemetry naturally picks up the new fields if logger reads `tool_use_blocks`.

**Build order:** Ships **after schema cleanup** (so its tests run against clean baseline). Figma sub-feature ships **after agentic runner core** is green — same file tree, additive only.

---

### Feature 3 — Conflict detection in memory recall

**Goal:** Two memories with high tag overlap + low content similarity get flagged; recall prefers the higher-trust one or annotates the conflict.

**NEW files:**
- _None_ if we keep the conflict scan as a method on `MemoryStore` and add the pairwise pass directly inside `budgetedRecall` opts. (Optional: extract `src/memory/conflict-detector.ts` for the pairwise comparator — preferred since it keeps `memory-engine.ts` pure.)
- **Recommended:** `src/memory/conflict-detector.ts` — pure functions `findConflictsAtWrite(newMemory, candidates): string[]` and `selectConflictAware(scored: ScoredMemory[]): ScoredMemory[]`. Engine remains pure; store calls it.

**MODIFIED files:**
| File | Rough lines | Change |
|---|---|---|
| `src/memory/types.ts` | line 31 (`MemoryRow`) | Add `conflicts_with_json: string` (NOT NULL DEFAULT `'[]'`) |
| `src/memory/types.ts` | line 55 (`Memory`) | Add `conflicts_with: readonly string[]` |
| `src/memory/db-migrations.ts` | after line 91 (`files_json` guard) | PRAGMA-guarded `ALTER TABLE memories ADD COLUMN conflicts_with_json TEXT NOT NULL DEFAULT '[]'` |
| `src/memory/memory-store.ts` | line 78 (`rowToMemory`) | `conflicts_with: JSON.parse(row.conflicts_with_json ?? '[]')` |
| `src/memory/memory-store.ts` | line 273 (`remember()`), line 360 (`upsert()`) | After sanitize, before INSERT: call `findConflictsAtWrite(content, tags, getCandidates({workdir, token_budget: small}))` → write `conflicts_with_json` for new row AND retroactively UPDATE conflicting peers to add the new id |
| `src/memory/memory-store.ts` | lines 315-344 + 411-439 (INSERT col lists) | Add `conflicts_with_json` to both column + value lists (18 → 19 cols) |
| `src/memory/memory-engine.ts` | line 195 (`budgetedRecall`) | Optional new param `opts?: { conflictPolicy?: 'prefer-higher-trust' \| 'annotate-both' }`; after sort+filter, if any candidates share an id in another candidate's `conflicts_with`, apply policy |
| `src/context/layers.ts` | line 255 (UNVERIFIED prefix logic) | Add `⚠ CONFLICTS WITH #N:` annotation when memory has non-empty `conflicts_with` overlap with other recalled memories |
| `src/tools/memory_search.ts` | lines 49-58 (response projection) | Include `conflicts_with` in MCP response for AI visibility |
| `src/cli/cmd-memory-ops.ts` (or wherever `memory why` lives) | — | `relay memory why <id>` already shows `ScoreComponents`; extend to show `conflicts_with` list |

**Integration point:**
1. **Write-time** — `MemoryStore.remember()` and `.upsert()` call the pure conflict detector against active workdir candidates. New row + retroactive UPDATE of peers are wrapped in same transaction.
2. **Read-time** — `memory-engine.ts:195 budgetedRecall` does its existing score-and-pack, then runs a pairwise pass over the packed set. Where two packed memories conflict, drop the lower-trust one (or annotate via context layer).

**Data flow:**
- WRITE: new content → sanitize → fetch peer candidates (workdir-scoped, ≤500 rows) → for each peer, compute tag-overlap × inverse-content-similarity → if score > threshold, record bidirectional conflict.
- READ: `budgetedRecall` selects N memories → pairwise check `conflicts_with` membership → either drop or pass conflict map to renderer.
- CONSUMES: `loadRecalledLessonsContent()` → `context/layers.ts` adds `⚠ CONFLICTS WITH #N:` prefix when rendering; downstream models see explicit conflict signal.

**Build order:** After schema cleanup (needs new column). **Sharpest with embeddings** (Feature 4) — without semantic similarity, content-similarity falls back to Jaccard tokens (weak on paraphrases per MEMORY-MAP §5). Can ship before embeddings with Jaccard; quality jumps when embeddings land.

---

### Feature 4 — Semantic embeddings via LM Studio `/v1/embeddings`

**Goal:** Cosine similarity on `nomic-embed-text-v1.5` replaces bag-of-words `computeContentScore`. Engine purity preserved.

**NEW files:**
- `src/memory/embedding-client.ts` — LM Studio `/v1/embeddings` client. Mirrors `auto-extract-runner.ts` patterns: `trimEndpoint`, `probeLmStudio`, `AbortController` timeout, never-throws contract (returns `null` on failure). Exports `embedText(content: string, opts?: { endpoint?; model?; timeoutMs? }): Promise<number[] | null>`.
- `src/memory/embedding-client.test.ts` — mock `fetch`, assert returns `number[]` on success, `null` on rejection.

**MODIFIED files:**
| File | Rough lines | Change |
|---|---|---|
| `src/memory/types.ts` | line 31 (`MemoryRow`) | Add `embedding_json: string \| null` |
| `src/memory/types.ts` | line 55 (`Memory`) | Add `embedding: readonly number[] \| null` |
| `src/memory/db-migrations.ts` | after line 91 (`files_json` guard) | PRAGMA-guarded `ALTER TABLE memories ADD COLUMN embedding_json TEXT` (nullable — older rows have NULL) |
| `src/memory/memory-store.ts` | line 78 (`rowToMemory`) | `embedding: row.embedding_json ? JSON.parse(row.embedding_json) : null` |
| `src/memory/memory-store.ts` | line 273 (`remember()`), 360 (`upsert()`) | After INSERT (sync), fire-and-forget background `embedText(content)` → UPDATE `embedding_json` lazily. Keeps `remember()` sync (no async cascade across callers) |
| `src/memory/memory-store.ts` | line 585 (`getCandidates`) | After candidate fetch: if `RELAY_EMBEDDING_MODEL` set, `embedText(query.query)`, compute cosine vs each candidate row's embedding, build `similarities: Map<memory_id, number>`. Pass to caller |
| `src/memory/memory-engine.ts` | new export | Add `cosineSim(a, b): number` (pure math) |
| `src/memory/memory-engine.ts` | line 115 (`scoreMemoryDetailed`) | Add optional `opts?: { semanticSimilarity?: number }`; if set, use as `contentScore` instead of calling `computeContentScore` |
| `src/memory/memory-engine.ts` | line 195 (`budgetedRecall`) | Add optional `similarities?: ReadonlyMap<string, number>` param; per-memory lookup forwards to `scoreMemory` |
| `src/memory/memory-store.ts` | `getCandidates` → `budgetedRecall` call site | Thread `similarities` map through |
| `src/memory/consolidation.ts` | line 24-37 (cluster) + `memory-store.ts:1217` (Jaccard call) | **Optional secondary benefit** — swap Jaccard for cosine in dedup. Defer if scope-pressed |

**Integration point:**
- **Write** — `remember/upsert` fire embedding generation in background micro-task; lazy UPDATE. Failure path: `embedding_json` stays NULL, fallback path covers.
- **Read** — `getCandidates` embeds query once per recall, computes cosine inline, passes `similarities` map to engine. Engine treats `semanticSimilarity` as drop-in replacement for `contentScore`.
- **Fallback** — Per-row fallback: row has `embedding=null` OR query embed failed → engine receives `undefined` for that id → falls back to existing word-overlap path. **No regression** for legacy data.

**Data flow:**
- WRITE: content → sanitize → INSERT (sync, returns id) → background `embedText(content)` → UPDATE `embedding_json = ?` WHERE memory_id = ?.
- READ: query → `getCandidates` → FTS5/recency narrow to ≤500 rows → if model env set, `embedText(query)` + cosine vs each row's embedding → engine ranks with semantic similarity replacing word-overlap.
- CONSUMES: `loadRecalledLessonsContent` consumes ranked results unchanged. Quality improvement is invisible to callers.

**Build order:** After schema cleanup. **Before delta extraction** (delta extraction's `getCandidates` call benefits from semantic ranking). **Before or independent of conflict detection** — conflict detection's "low content similarity" check sharpens when cosine is available, but Jaccard works as initial proxy.

---

### Feature 5 — Delta extraction in auto-extract

**Goal:** Auto-extract prompt is conditioned on what's already known. Re-extraction of known patterns suppressed; contradictions surfaced as conflicts.

**NEW files:**
- _None._ Pure prompt + plumbing change.

**MODIFIED files:**
| File | Rough lines | Change |
|---|---|---|
| `src/memory/auto-extract-runner.ts` | lines 46-54 (`PROMPT_TEMPLATE`) | Insert `Existing known patterns:` block above `Transcript:` placeholder; add `<<<EXISTING>>>` token |
| `src/memory/auto-extract-runner.ts` | line 65 (`buildPrompt(transcript)`) | Change signature → `buildPrompt(transcript: string, existing: readonly Memory[]): string`. Format `existing` as bulleted list (compact, ≤200 chars each, capped at e.g. top-20) |
| `src/memory/auto-extract-runner.ts` | line 33 (`ExtractionOptions`) | Add `existing?: readonly Memory[]` field |
| `src/memory/auto-extract-runner.ts` | line 222-246 (`extractLessonsViaLmStudio`) | Thread `opts.existing` into `buildPrompt(opts.transcript, opts.existing ?? [])` |
| `src/cli/cmd-memory-auto-extract.ts` | line 405-411 (`extract({...})` call site) | Before calling: `const store = new MemoryStore(); const existing = store.getCandidates({ workdir: payload.value.cwd, token_budget: 4000 });`. Pass as `existing`. |
| `src/memory/types.ts` | line 11 (`MemorySource`) | Add new variant `'auto-run-recorder-delta'` OR reuse existing + populate `conflicts_with` |
| `src/memory/auto-extract-runner.ts` | response parser (around line 200) | If LM Studio returns lesson flagged as contradicting an existing id, populate `conflicts_with` on the new memory at write time |

**Integration point:**
- **Prompt** — single template replacement in `PROMPT_TEMPLATE`. Backward compatible (empty `existing` → empty block, prompt degenerates to current behavior).
- **Store coupling** — `cmd-memory-auto-extract.ts` already constructs `MemoryStore` for the write path; add a `getCandidates` call before the extraction round-trip.
- **Conflict bridge** — Feature 3's `conflicts_with_json` column is the natural sink for contradictions surfaced by the extractor.

**Data flow:**
- IN: SessionEnd transcript window (existing) + `getCandidates({workdir, token_budget: 4000})` recall (new).
- THROUGH: LM Studio chat-completion with augmented prompt: existing patterns + transcript → lessons that ADD, CONTRADICT, or REFINE.
- OUT: Per-lesson write via `handleRemember('auto-run-recorder')` — same path as today. Contradictions populate `conflicts_with` (Feature 3 column).
- CONSUMES: `~/.relay/auto-extract.log` audit line gains `existing_count` and `contradictions_count` fields.

**Build order:** **After schema cleanup AND conflict detection** (needs `conflicts_with_json` column to land contradictions cleanly). Benefits from embeddings (Feature 4) for the `getCandidates` prefetch but does not strictly require them.

---

### Feature 6 (deferred-from-v0.1) — Budget command

**Goal:** Surface costs by provider + workdir. Replace stub at `cmd-budget.ts:19-31`.

**NEW files:**
- `src/cli/cmd-budget-show.ts` (or extend existing `src/cli/cmd-budget.ts` — filename per ROADMAP note, but actual existing file is `cmd-budget.ts`; **reuse existing file**, no rename).
- Possibly `src/cli/cmd-budget-set.ts`, `cmd-budget-list.ts`, `cmd-budget-alerts.ts` if expanding the dispatcher (`cli.ts:640-656` currently only handles `show`).

**MODIFIED files:**
| File | Rough lines | Change |
|---|---|---|
| `src/runtime/budget/db-migrations.ts` | lines 5-13, 22-32 (CHECK on `scope`) | Extend CHECK to include `'provider'` and `'workdir'`. **Requires drop+recreate** or version-gated migration (per BUDGET-MAP §1) — chain with Feature 1's `schema_version` |
| `src/runtime/budget/budget-store.ts` | line 32-65 (`getCurrentCost`) | Add branches for `scope === 'provider'` (filter `cost_events.provider = ?`), `scope === 'workdir'` (filter `cost_events.workdir = ?`) |
| `src/runtime/budget/budget-store.ts` | line 132-171 (`checkBudgets`) | Extend early-skip guard at `:140` to handle provider/workdir scope mismatches |
| `src/contracts/budget.ts` | scope enum | Add `'provider'`, `'workdir'` to enum |
| `src/cli/cmd-budget.ts` | lines 19-31 | Replace stub with `executeBudgetShowCommand` that calls `BudgetStore.listBudgetLimits` + `listBudgetAlerts`, formats by scope |
| `src/cli.ts` | line 244 (help text) | Remove `0.2.0` deferred mention |
| `src/cli.ts` | lines 640-656 (`dispatchBudget`) | Add `set`/`list`/`alerts` subcommand branches |

**Integration point:** Fully isolated. `cost_events` table already has `provider` and `workdir` columns (`db.ts:117, 123`). Only schema CHECK and dispatcher logic change.

**Data flow:**
- IN: `relay budget show --provider <name> --workdir <path> --json`.
- THROUGH: `BudgetStore.getCurrentCost({scope: 'provider', scope_value: 'lmstudio'})` → SUM(`cost_events.cost_usd`) WHERE provider = ?.
- OUT: JSON envelope `{ provider, workdir, period, current_usd, limit_usd, pct_used }`.

**Build order:** Independent. Can ship anytime after schema cleanup. Lowest risk, smallest scope — good "warm-up" or "finish-line" candidate.

---

## 3. Dependency graph

```
                          ┌──────────────────────────┐
                          │ F1: Schema cleanup       │
                          │ + schema_version table   │  PREREQUISITE
                          └────┬─────────────────┬───┘
                               │                 │
              ┌────────────────┘                 └────────────────┐
              ▼                                                   ▼
   ┌──────────────────────┐                          ┌────────────────────────┐
   │ F2a: Agentic LM      │                          │ F4: Semantic embeddings│
   │     Studio runner    │  (no memory dep)         │ (embedding_json col,   │
   │     (lmstudio-       │                          │  embedding-client,     │
   │     agentic.ts +     │                          │  cosineSim, getCandid- │
   │     tool dispatch)   │                          │  ates threading)       │
   └──────────┬───────────┘                          └────┬───────────────────┘
              │                                           │
              ▼                                           ▼
   ┌──────────────────────┐                  ┌──────────────────────────────┐
   │ F2b: Figma tool set  │                  │ F3: Conflict detection       │
   │     (figma.ts        │                  │     (conflicts_with_json col,│
   │     handlers,        │                  │     write-time scan,         │
   │     wired into tool  │                  │     pairwise recall pass,    │
   │     dispatch)        │                  │     context layer annot.)    │
   └──────────────────────┘                  └──────────┬───────────────────┘
                                                        │
                                                        ▼
                                            ┌──────────────────────────────┐
                                            │ F5: Delta extraction         │
                                            │     (prompt template,        │
                                            │     getCandidates prefetch,  │
                                            │     contradiction → conflict │
                                            │     bridge)                  │
                                            └──────────────────────────────┘

   ┌──────────────────────┐
   │ F6: Budget command   │  (depends only on F1's schema_version          │
   │     (per-prov+wkdir) │   pattern; fully isolated otherwise)            │
   └──────────────────────┘
```

### Phase 1 candidates (no deps beyond F1)
- **F1: Schema cleanup** — must ship first; gates every column addition.
- **F2a: Agentic LM Studio runner** — independent of memory subsystem entirely; only consumes existing `WorkerTask`/`WorkerResult` contract.
- **F6: Budget command** — fully isolated (cost_events columns already exist).

### Phase 2 candidates (depend on Phase 1)
- **F4: Semantic embeddings** — depends on F1 (column add). Independent of F2a/F2b/F3/F5.
- **F3: Conflict detection** — depends on F1 (column add). Sharpened by F4 (semantic similarity in candidate scan) but not blocked by it.

### Phase 3 candidates (depend on Phase 2)
- **F2b: Figma tools** — depends on F2a (agentic runner). Pure tool-set extension.
- **F5: Delta extraction** — depends on F1 (column) + F3 (`conflicts_with_json` sink). Benefits from F4 (better candidate ranking for prefetch).

### Critical path
**F1 → F3 → F5** (3 features in series). F2a/F2b/F4/F6 are parallel branches that can ship without blocking the critical path. F2b ships off F2a.

---

## 4. ROADMAP §Sequencing comparison

ROADMAP §Sequencing (line 210-220) says:
```
1. Schema cleanup
2. Agentic local runner
3. Conflict detection
4. Semantic embeddings
5. Delta extraction
6. Figma integration
7. Budget command
```

**Research-driven recommendation (justified delta):**

| Order | ROADMAP | Research | Justification |
|---|---|---|---|
| 1 | Schema cleanup | **Same** | True prerequisite. No change. |
| 2 | Agentic runner | **Same** | Self-contained, unblocks Figma. No change. |
| 3 | Conflict detection | **F4 Embeddings → F3 Conflict** | Per MEMORY-MAP cross-deps note (line 335): "§3 ← §4 (semantic similarity sharpens conflict candidate detection beyond tag overlap)". Conflict detection's "low content similarity" check is **weak with Jaccard** (misses paraphrases) but **strong with cosine**. Shipping embeddings first means conflict detection lands at full quality, not v1-needs-rework. |
| 4 | Embeddings | **F3 Conflict (sharpened)** | Now lands with semantic similarity available. |
| 5 | Delta extraction | **Same** | Depends on conflict detection's column. No change. |
| 6 | Figma | **Same** (or slot anywhere after F2a) | Depends only on F2a. Can ship in parallel with F3/F4/F5. |
| 7 | Budget | **Same** (or slot anywhere after F1) | Fully isolated. Lowest-risk "warm-up" candidate — could even ship first to validate the `schema_version` plumbing on a low-blast-radius surface. |

**Recommended optimized sequence:**
```
1. F1 Schema cleanup           (prerequisite, ~1-2 days)
2. F6 Budget command           (isolated, validates schema_version on a small target, ~1 day)
3. F2a Agentic LM Studio core  (independent of memory, ~3-4 days)
4. F4 Semantic embeddings      (memory column + scoring, ~2-3 days)
5. F3 Conflict detection       (now sharpened by cosine, ~2-3 days)
6. F5 Delta extraction         (depends on F3 column, ~1-2 days)
7. F2b Figma tools             (depends on F2a, can slot in parallel after step 3, ~2 days)
```

Total: 7 sequential slots, but F2b can run parallel with F4/F3/F5 if there's a second contributor (or as breathing-room work).

---

## 5. Anti-patterns to avoid (Relay-specific)

### Anti-pattern 1: Adding columns without PRAGMA guard
**What people do:** Direct `ALTER TABLE memories ADD COLUMN x` in DDL_STATEMENTS.
**Why wrong:** DDL_STATEMENTS runs every boot; ALTER on existing column = error.
**Do instead:** Mirror `db-migrations.ts:65-93` pattern — `PRAGMA table_info` → Set → `if (!cols.has('x'))` guard.

### Anti-pattern 2: Making `MemoryStore.remember()` async
**What people do:** `await embedText(...)` inside `remember`.
**Why wrong:** `better-sqlite3` is synchronous; `remember` is sync everywhere it's called (MCP tool, CLI, auto-extract pipeline). Async cascade hits every caller, large diff.
**Do instead:** Sync INSERT, background micro-task for embedding generation with lazy UPDATE (per EMBEDDING-PATTERN §6).

### Anti-pattern 3: Importing fetch/HTTP into `memory-engine.ts`
**What people do:** Compute cosine inside engine, fetch embeddings inside engine.
**Why wrong:** Breaks the pure-function contract (no I/O, no DB). Breaks engine unit tests that have no network mock.
**Do instead:** Embedding fetched in `memory-store.ts::getCandidates` (I/O layer); pre-computed `similarities` map passed into engine as parameter (per EMBEDDING-PATTERN §3-4).

### Anti-pattern 4: Adding a new provider name `'lmstudio-agentic'`
**What people do:** Extend `provider` type union with new variant.
**Why wrong:** Triggers 8-site fan-out (`cmd-run.ts`, `cmd-parallel.ts`, `cmd-completion.ts`, `cmd-init.ts`, `contracts/delegate.ts`, `cli.ts` validation, etc. — see WORKERS-MAP §6).
**Do instead:** Reuse `'lmstudio'`, switch within dispatch on env flag or `task.agentic`. Two-site change.

### Anti-pattern 5: Wrapping `mcp__relay-mcp__delegate` in a Task subagent
**What people do:** Spawn a CC subagent that calls one delegate.
**Why wrong:** ~17k tokens overhead per call (per project CLAUDE.md).
**Do instead:** Call delegate directly in parallel from main session.

---

## 6. Integration points summary table

| Feature | New files | Modified files (count) | Schema change | Cross-feature dep |
|---|---|---|---|---|
| F1 Schema cleanup | 0 | 2 (`db.ts`, `db-migrations.ts`) | NEW `schema_version` table; DROP 11 tables | — (prerequisite) |
| F2a Agentic runner | 2 (`lmstudio-agentic.ts`, test) | 4 (`runner.ts`, `types.ts`, `cmd-run.ts`, `cmd-parallel.ts`) | None | — |
| F2b Figma tools | 1 (`tools/figma.ts`) | 1 (tool registration in `lmstudio-agentic.ts`) | None | F2a |
| F3 Conflict detection | 1 (`conflict-detector.ts`) | 6 (`types.ts`, `db-migrations.ts`, `memory-store.ts`, `memory-engine.ts`, `context/layers.ts`, `tools/memory_search.ts`) | NEW col `conflicts_with_json` | F1; sharpened by F4 |
| F4 Embeddings | 2 (`embedding-client.ts`, test) | 5 (`types.ts`, `db-migrations.ts`, `memory-store.ts`, `memory-engine.ts`, optionally `consolidation.ts`) | NEW col `embedding_json` | F1 |
| F5 Delta extraction | 0 | 3 (`auto-extract-runner.ts`, `cmd-memory-auto-extract.ts`, `types.ts`) | None (uses F3's column) | F1, F3; benefits from F4 |
| F6 Budget command | 0-3 (depending on subcommand expansion) | 5 (`db-migrations.ts`, `budget-store.ts`, `contracts/budget.ts`, `cmd-budget.ts`, `cli.ts`) | CHECK extension on `budget_limits.scope` | F1 (versioned migration) |

---

## Sources

- `/Users/ghanavati/ai-stack/Projects/Relay/docs/architecture.md` (baseline architecture, v0.1.2)
- `/Users/ghanavati/ai-stack/Projects/Relay/ROADMAP.md` §1-7, §Sequencing (line 210-220)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/PROJECT.md` (v0.2 milestone scope)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/WORKERS-MAP.md` (worker contract + dispatch insertion strategy)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/MEMORY-MAP.md` (MemoryStore method list, scoring purity, cross-dep table at §8)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/BUDGET-CLI-SCHEMA-MAP.md` (DDL_STATEMENTS, orphan-table verification, dispatchBudget)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/AGENTIC-WORKER-PATTERN.md` (codex.ts pattern, tool-loop outline, termination matrix)
- `/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/EMBEDDING-PATTERN.md` (purity preservation, fallback strategy, async write pattern)

---

*Architecture research for: Relay v0.2 integration. Confidence HIGH — every claim is grounded in direct read of existing source or pre-existing scrap maps with file:line citations.*
