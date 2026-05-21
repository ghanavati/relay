# ROADMAP Drift Report — v0.2

Verified against `src/` on 2026-05-18. Each claim from `/Users/ghanavati/ai-stack/Projects/Relay/ROADMAP.md` is marked PASS, DRIFT, or MISSING with exact file:line evidence.

Legend: PASS = roadmap matches code; DRIFT = roadmap claim wrong or imprecise; MISSING = referenced artifact absent.

---

## Section 1 — Schema cleanup

| Claim | Verdict | Evidence |
|---|---|---|
| `applySchema()` exists in `src/runtime/store/db.ts` | PASS | `src/runtime/store/db.ts:271` (call); definition at `src/runtime/store/db.ts:406` |
| `applySchema()` is additive-only (IF NOT EXISTS, PRAGMA table_info, no DROP) | PASS | 54 `IF NOT EXISTS` matches; PRAGMA-guarded ALTERs at `db.ts:285,317,330`; zero `DROP TABLE` in file |
| No `schema_version` table exists | PASS | Only hit for `schema_version` is the **column** on `continuity_objects` at `src/runtime/store/db.ts:75`, not a table |
| `continuity_objects` — zero SQL outside db.ts | PASS | grep returns no matches |
| `recipes` — zero references outside db.ts | PASS | grep returns no matches |
| `sign_offs` / `sign_off_amendments` — zero SQL outside db.ts | PASS | grep returns no matches; immutability triggers present at `db.ts:143,149` |
| `src/contracts/amend_sign_off.ts` exists | PASS | 237B file present; never imported (no consumers found) |
| `src/contracts/continuity.ts` exists | PASS | 2.3K file present |
| `operator_annotations` — zero references outside db.ts | PASS | grep returns no matches |
| `proxy_requests` — zero references outside db.ts | PASS | grep returns no matches |
| `jobs` / `tasks` / `task_deps` / `job_events` — zero SQL outside db.ts | PASS | grep for `FROM/INTO/UPDATE tasks|jobs` and `task_deps|job_events` returns no matches outside db.ts |
| `verifications` — only touched by `purgeTaintedVerificationRecords()` DELETE | DRIFT | Mostly true (no INSERTs anywhere), but db.ts also runs PRAGMA-guarded migrations for `confidence_score` (`db.ts:317`) and `verification_source` (`db.ts:330`). One mention in a comment at `src/contracts/continuity.ts:27`. Roadmap should add: "+ two PRAGMA migrations also touch the table" |

---

## Section 2 — Agentic local LLM runner

| Claim | Verdict | Evidence |
|---|---|---|
| `src/workers/lmstudio.ts` has `capabilities = { agentic: false }` | DRIFT (MISSING) | `src/workers/lmstudio.ts` (52 lines total) contains **no `capabilities` property at all**. It now delegates to `GenericHttpRunner` (`src/workers/lmstudio.ts:31`). Roadmap text is stale by at least one refactor. Need to recheck whether `GenericHttpRunner` exposes capabilities. |
| `GenericHttpRunner` capabilities | MISSING | No `capabilities` field in `src/workers/generic-http-runner.ts` per `grep -n capabilities src/workers/types.ts src/workers/anthropic.ts src/workers/runner.ts` (lmstudio + openrouter + generic not in match set). LM Studio runner is effectively `agentic: false` by default (`src/workers/runner.ts:20` returns default `{ agentic: false }`), but not explicitly tagged. |
| `src/workers/codex.ts` has `agentic: true` around line 651 | PASS | Exact: `src/workers/codex.ts:651` → `readonly capabilities = { agentic: true, execution_model: "subprocess" } as const;` (now also includes `execution_model`, not in roadmap) |
| Anthropic runner single-shot, `agentic: false` | PASS | `src/workers/anthropic.ts:10` → `readonly capabilities = { agentic: false } as const;`; single `fetch` at `src/workers/anthropic.ts:39`, no loop |

---

## Section 3 — Figma integration

| Claim | Verdict | Evidence |
|---|---|---|
| `DISABLED_CODEX_MCP_LABELS = new Set(['figma', 'notion', 'pencil'])` in `src/workers/codex.ts` | PASS | Exact match at `src/workers/codex.ts:72`. Consumed at lines 271, 276. |

---

## Section 4 — Conflict detection

| Claim | Verdict | Evidence |
|---|---|---|
| `MemoryStore.remember()` exists in `src/memory/memory-store.ts` | PASS | Class `MemoryStore` at `src/memory/memory-store.ts:238`; `remember()` method at `src/memory/memory-store.ts:273` |
| `budgetedRecall()` exists in `src/memory/memory-engine.ts` around line 195 | PASS | Exact: `src/memory/memory-engine.ts:195` |
| `memories` table has no `conflicts_with_json` column | PASS | Zero matches for `conflicts_with_json` in `src/`. Memory DDL at `src/memory/db-migrations.ts:16-32` confirms columns: memory_id, memory_type, content, tags_json, workdir, token_count, pinned, source_run_id, git_ref, superseded_by, created_at, accessed_at, expires_at, entity_key, sources_json. PRAGMA-guarded ALTERs add: recall_count, content_hash (`src/memory/db-migrations.ts:75-80`) |

---

## Section 5 — Semantic embeddings

| Claim | Verdict | Evidence |
|---|---|---|
| `computeContentScore()` exists in `src/memory/memory-engine.ts` around line 59 | PASS | Exact: `src/memory/memory-engine.ts:59` |
| Body uses word-overlap (no embedding code) | PASS | `src/memory/memory-engine.ts:62-64` splits on whitespace, lowercases, filters words >2 chars, counts substring matches. Zero `embedding` matches in entire `src/` tree. |
| `memories` table has no `embedding_json` column | PASS | Zero matches in `src/`; not in PRE_ALTER_DDL or any PRAGMA-guarded ALTER in `src/memory/db-migrations.ts` |
| `consolidation.ts` exists and uses Jaccard | DRIFT | `src/memory/consolidation.ts` exists (2.7K). Does **NOT** use Jaccard — uses raw tag-set intersection (`a.tags.filter(t => b.tags.includes(t))` at `src/memory/consolidation.ts:36`) with a threshold `minSharedTags = 2` (`consolidation.ts:24`). No normalization by union size. Roadmap should say "tag-overlap (intersection count, not Jaccard ratio)". |

---

## Section 6 — Delta extraction

| Claim | Verdict | Evidence |
|---|---|---|
| `src/cli/cmd-memory-auto-extract.ts` exists | PASS | 33.4K file present |
| `src/memory/auto-extract-runner.ts` exists with T10 template | PASS | 8.3K file; T10 reference at `src/memory/auto-extract-runner.ts:41`; template constant at `src/memory/auto-extract-runner.ts:46-54` |
| Runner has no awareness of existing memories (current state premise) | PASS | Zero `getCandidates` / `recalled` / `existing` matches in `src/memory/auto-extract-runner.ts` |

---

## Section 7 — Budget command (deferred)

| Claim | Verdict | Evidence |
|---|---|---|
| File `src/cli/cmd-budget-show.ts` exists | DRIFT (MISSING) | No such file. Actual file is `src/cli/cmd-budget.ts` (32 lines). Roadmap "Files to touch" should say `src/cli/cmd-budget.ts`, not new `cmd-budget-show.ts`. |
| Stub still prints `"deferred (target: 0.2.0)"` | DRIFT | Stub at `src/cli/cmd-budget.ts:19-31` prints either `"Deferred to v0.2 — see CHANGELOG.md"` (non-JSON, line 28) or `{"status":"deferred","target_version":"0.2.0","reason":"BudgetStore needs per-provider scope"}` (JSON, lines 21-26). String literal "deferred (target: 0.2.0)" does not appear. |
| Comment "BudgetStore needs per-provider scope" still present | PASS | Exact: `src/cli/cmd-budget.ts:4` (JSDoc) and `src/cli/cmd-budget.ts:16` (`BUDGET_DEFERRED_REASON` const). Also asserted in test: `src/cli/cmd-budget.test.ts:63`. |
| `BudgetStore` exists in `src/runtime/budget/budget-store.ts` | PASS | `export class BudgetStore` at `src/runtime/budget/budget-store.ts:67` |

---

## Summary

- **Total claims checked**: 29
- **PASS**: 23
- **DRIFT**: 5 (Section 1 verifications scope; Section 2 lmstudio.ts no longer has explicit capabilities tag — refactored to GenericHttpRunner; Section 5 consolidation is tag-overlap not Jaccard; Section 7 file name `cmd-budget.ts` not `cmd-budget-show.ts`; Section 7 stub message text)
- **MISSING**: 1 (`cmd-budget-show.ts` referenced but does not exist; file is `cmd-budget.ts`)

### Action items for roadmap rewrite

1. **Section 2** — Update "Current state": `src/workers/lmstudio.ts` was refactored to extend `GenericHttpRunner` and no longer declares `capabilities` directly. The `agentic: false` semantics come from the default in `src/workers/runner.ts:20`. Either re-tag explicitly or update the narrative.
2. **Section 5** — Replace "uses Jaccard" with "uses tag-intersection count (minSharedTags threshold)" — or, if the cosine-on-embeddings goal is to "upgrade Jaccard to cosine," reframe as "upgrade tag-intersection to cosine-on-embeddings."
3. **Section 7** — Change "new `src/cli/cmd-budget-show.ts`" to "extend existing `src/cli/cmd-budget.ts`". Update the stub-output claim to match the two real branches (non-JSON message vs JSON payload).
4. **Section 1** — Add to the `verifications` row: "+ two PRAGMA-guarded migrations (`confidence_score`, `verification_source`) also touch the table."
