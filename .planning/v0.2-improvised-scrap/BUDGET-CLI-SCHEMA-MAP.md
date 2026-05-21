# BUDGET / CLI / SCHEMA MAP (v0.2)

**Date:** 2026-05-18
**Scope:** ROADMAP items #1 (schema cleanup) + #7 (budget command)
**Mode:** Read-only audit. No code changes.

---

## 1. BudgetStore — `src/runtime/budget/budget-store.ts`

### Current schema (DDL lives in `src/runtime/budget/db-migrations.ts`)

`budget_limits` (`db-migrations.ts:5-13`):
- `limit_id` TEXT PK
- `scope` TEXT CHECK(`model|owner|global`)
- `scope_value` TEXT
- `limit_usd` REAL
- `period` TEXT CHECK(`daily|monthly|alltime`)
- `created_at`, `updated_at` INTEGER
- UNIQUE INDEX on (`scope`, `scope_value`, `period`) — `db-migrations.ts:17-19`

`budget_alerts` (`db-migrations.ts:22-32`):
- `alert_id` TEXT PK
- same `scope` + `scope_value` shape
- `limit_usd`, `current_usd`, `pct_used` REAL
- `level` TEXT CHECK(`warning|exceeded`)
- `period`, `created_at`
- INDEXES on (`scope`, `scope_value`) and (`level`) — `db-migrations.ts:36-43`

### Methods (`budget-store.ts:67-172`)

| Method | Lines | SQL surface |
|---|---|---|
| `setBudgetLimit` | 68-85 | SELECT/UPDATE/INSERT `budget_limits` |
| `listBudgetLimits` | 87-97 | SELECT `budget_limits` w/ optional `scope`/`scope_value` filter |
| `recordAlert` | 99-115 | INSERT `budget_alerts` |
| `listBudgetAlerts` | 117-130 | SELECT `budget_alerts` w/ filters + LIMIT |
| `checkBudgets` | 132-171 | iterates limits; calls `getCurrentCost` (module-private, `:32-65`) which sums `cost_events.cost_usd` by scope |

Helpers: `periodSinceMs` (`:26-30`), `getCurrentCost` (`:32-65`) — joins `cost_events` ↔ `models` on `owner` scope.

### Where provider/workdir scope MUST be added (v0.2 — issue #7)

**Confirmed absent:** `grep workdir|provider src/runtime/budget/budget-store.ts` → **0 matches**.

CHECK constraint allows only `model|owner|global` (`db-migrations.ts:7,24`). To add provider/workdir scope:

1. **Schema (`db-migrations.ts:7,24`)** — extend CHECK list to `('model','owner','global','provider','workdir')`. SQLite cannot alter a CHECK in place; either:
   - drop+recreate via versioned migration (preferred — see §3), or
   - drop CHECK entirely and validate in TS at insert time.
2. **`getCurrentCost` (`budget-store.ts:32-65`)** — add branches for `scope === 'provider'` (filter `cost_events.provider = ?`) and `scope === 'workdir'` (filter `cost_events.workdir = ?`). Both columns already exist on `cost_events` (`db.ts:117, 123`) — no new indexes needed beyond existing `idx_cost_events_workdir` (`db.ts:190`).
3. **`checkBudgets` (`budget-store.ts:132-171`)** — extend the early-skip guard at `:140` (currently `if (limit.scope === 'model' && limit.scope_value !== model) continue;`) to handle provider/workdir scope mismatches. Callers must pass `provider` and `workdir` alongside `model`.
4. **Contracts (`src/contracts/budget.ts`)** — `SetBudgetLimitArgs.scope` enum + `BudgetLimitRow.scope` enum must include the new values. (Not read here; verify before edit.)

---

## 2. CLI budget command — `src/cli/cmd-budget.ts`

**Filename note:** roadmap says `cmd-budget-show.ts` but actual file is `cmd-budget.ts`. No `-show` suffix exists.

### Current stub (`cmd-budget.ts`, 32 lines total)

```
BUDGET_DEFERRED_TARGET   = '0.2.0'                              :15
BUDGET_DEFERRED_REASON   = 'BudgetStore needs per-provider scope' :16
BUDGET_DEFERRED_MESSAGE  = 'Deferred to v0.2 — see CHANGELOG.md'  :17
```

`executeBudgetShowCommand(args, io)` (`:19-31`):
- `args.json === true` → emits `{status:'deferred', target_version:'0.2.0', reason:'BudgetStore needs per-provider scope'}` JSON line
- else → emits literal `'Deferred to v0.2 — see CHANGELOG.md\n'`
- returns `0` (NOT 64 — note inconsistency with `futureCmds` branch in cli.ts:898 which returns 64 for `corpus`)

**Verified:** target IS `0.2.0` (`:15`). Stub still prints deferred message — confirmed.

### Registration (`src/cli.ts:640-656`)

`dispatchBudget(rest)`:
- `:644-647` — no action → stderr `'relay budget requires an action: show\n'`, return 2
- `:649-652` — `action === 'show'` → dynamic import `./cli/cmd-budget.js`, call `executeBudgetShowCommand({ json: isBool(flags, 'json') }, io)`
- `:654-655` — unknown action → stderr `"relay budget: unknown action '${action}'. Try: show\n"`, return 2

Wired in main dispatch at `cli.ts:715`: `if (cmd === 'budget') return dispatchBudget(rest);`

Help text at `cli.ts:244` (per grep) mentions target `0.2.0`.

---

## 3. Schema infrastructure — `src/runtime/store/db.ts`

### `applySchema()` (`db.ts:406-427`)

Two-phase: bulk DDL loop, then ordered migration calls.

```
applySchema(db):
  for stmt in DDL_STATEMENTS: db.prepare(stmt).run()      :407-409
  purgeTaintedVerificationRecords(db)                      :410
  migrateIdempotencyExpiresAt(db)                          :411
  migrateTasksLeaseFields(db)                              :412
  migrateRunsVerificationStatus(db)                        :413
  migrateVerificationsConfidenceScore(db)                  :414
  migrateVerificationsSource(db)                           :415
  migrateProxyRequestsFullBody(db)                         :416
  migrateCapabilityTables(db)        // external           :417
  migrateMemoryTables(db)            // external           :418
  migrateSessionFields(db)                                 :419
  migrateBudgetTables(db)            // external           :420
  migrateRunsTaskHash(db)                                  :421
  migrateRunEventsTraceFields(db)                          :422
  migrateRunsRecalledMemories(db)                          :423
  migrateRunsThinkingBlocks(db)                            :424
  migrateCostEventsTextColumn(db)                          :425
  migrateAuthTables(db)              // external           :426
```

### `DDL_STATEMENTS` array (`db.ts:15-252`) — 1-statement-per-string idempotent CREATE list

Includes (with table → line ranges):
- `runs` :16-37 | `run_events` :38-44 | `command_events` :45-63 | `idempotency_keys` :64-69
- **`continuity_objects`** :71-86 | **`recipes`** :87-95 (FK → continuity_objects)
- `run_diffs` :99-105 | **`verifications`** :106-113
- `cost_events` :114-125 (has `provider`, `workdir`, `model` columns)
- **`sign_offs`** :126-132 | **`sign_off_amendments`** :134-142 | sign_off triggers :143-153
- **`proxy_requests`** :154-169 | `relay_sessions` :171-186
- **`jobs`** :197-204 | **`tasks`** :205-216 | **`task_deps`** :217-222 | **`job_events`** :223-229
- **`operator_annotations`** :232-240
- `memory_reads` :243 | `corpora` :247 + `corpora_fts` :248-251

### Where `schema_version` table goes (NEW for v0.2 cleanup)

Currently **no `schema_version` table exists** and **no `PRAGMA user_version` usage** (`grep schema_version|user_version` → only hit is `continuity_objects.schema_version` *column* at `db.ts:75`).

Insertion point: **first DDL in `DDL_STATEMENTS` (before `db.ts:15`)** so it exists before any migration runs. Suggested shape:

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
)
```

Then bootstrap row inserted at the top of `applySchema` (`db.ts:406`) before the DDL loop, and each new migration writes its version on completion.

### Where DROP migrations would chain in (for orphan-table cleanup)

Pattern: add a new `migrateDropOrphansV02(db)` function alongside the existing PRAGMA-guarded migrations (model: `migrateIdempotencyExpiresAt` at `db.ts:380-386`). Call it from `applySchema` **after** `migrateAuthTables(db)` at `db.ts:426` so the version check sees a fully-migrated DB before deciding to drop.

Inside the function, guard with `SELECT version FROM schema_version WHERE version >= N` to make it idempotent (since `DROP TABLE IF EXISTS` is already safe but writing the version marker isn't). Tables to drop are §4 below.

---

## 4. Orphan tables — zero-call-site verification

Method: `grep -rn "\b<table>\b" src/ --include="*.ts" -l | grep -v "runtime/store/db.ts"` then sub-filtered to exclude test files and rule out incidental keyword matches.

| Table | Files outside `db.ts` | Real SQL use? | Verdict |
|---|---|---|---|
| `continuity_objects` | 0 | 0 | **ORPHAN** |
| `recipes` | 0 | 0 | **ORPHAN** |
| `sign_offs` | 0 | 0 | **ORPHAN** (immutability triggers at `db.ts:143-153` also orphaned) |
| `sign_off_amendments` | 0 | 0 | **ORPHAN** |
| `operator_annotations` | 0 | 0 | **ORPHAN** |
| `proxy_requests` | 0 | 0 | **ORPHAN** (despite `migrateProxyRequestsFullBody` :340-349) |
| `jobs` | 0 | 0 | **ORPHAN** |
| `tasks` | 8 (false positives) | 0 | **ORPHAN** (matches are `spec.tasks[]` in `cmd-parallel.ts:92-133`, `delegate_parallel.ts:6-24`, prose comments — NO `FROM tasks`/`INTO tasks`/`UPDATE tasks` anywhere) |
| `task_deps` | 0 | 0 | **ORPHAN** |
| `job_events` | 0 | 0 | **ORPHAN** |
| `verifications` | 1 (`contracts/continuity.ts:27`) | 1 read in db.ts itself | **PARTIAL** — only call site outside db.ts is a Zod schema docstring (`run_id: 'Filter verifications by run_id'`); db.ts has `DELETE FROM verifications WHERE reason LIKE ?` (`:256, 403`) for tainted-record purge. No INSERT/SELECT anywhere. Effectively orphan. |

**Cascade caveats:**
- `recipes` has FK → `continuity_objects` (`db.ts:89`): drop in order `recipes` → `continuity_objects`.
- `task_deps` has FKs → `jobs`, `tasks` (`db.ts:218-220`): drop `task_deps` first, then `tasks`, then `jobs`.
- `sign_off_amendments` has FK → `sign_offs` (`db.ts:141`): drop amendments first, then sign_offs (also drop the two triggers at `db.ts:143-153`).
- Migrations to remove when dropping: `migrateTasksLeaseFields` (`db.ts:284-299`) and `migrateProxyRequestsFullBody` (`db.ts:340-349`) and `migrateVerificationsConfidenceScore` (`:316-322`) and `migrateVerificationsSource` (`:329-338`).
- Indexes to drop alongside: `idx_sign_offs_run_id` (:133), `idx_proxy_requests_created_at` (:170), `idx_continuity_objects_kind/status` (:96-97), `idx_recipes_object_id` (:98), `idx_verifications_run_id` (:196), `idx_tasks_job_id` (:230), `idx_job_events_job_id` (:231), `idx_operator_annotations_*` (:241-242).

---

## 5. CLI command patterns — 3 examples

### Common contract: `CliIO` interface (`src/cli/commands.ts:8-12`)

```typescript
export interface CliIO {
  cwd: string;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}
```

All command files import `type { CliIO } from './commands.js'`. The dispatcher (`src/cli.ts`) constructs a real `io` object and passes it to every `execute*Command`.

### `--json` flag pattern

Every command takes an args object with `json: boolean`. Parsed by `isBool(flags, 'json')` in `cli.ts` (e.g. `:651, 729, 800`). When set:
- Single JSON object/array printed via `JSON.stringify(...) + '\n'` to stdout
- No headers, no colors, no human prose
- Errors still go to stderr as plain text

Examples:
- `cmd-budget.ts:20-29` — JSON envelope `{status, target_version, reason}` vs literal string
- `cmd-memory-recent.ts:87-90` — `JSON.stringify(memories.map(toJsonEntry)) + '\n'`
- `cmd-info.ts:330-333` — `JSON.stringify(report) + '\n'`

### Exit code pattern

| Code | Meaning | Where |
|---|---|---|
| 0 | success | all three return 0 on happy path |
| 2 | bad args / unknown action | `cmd-memory-recent.ts:79-81` (bad --limit), `cli.ts:646, 655` (missing/unknown budget action), `cli.ts:735, 810, 817, 830, 845` (general bad-arg pattern) |
| 64 | deferred future command | `cli.ts:898` (only used for `corpus`; `budget` returns 0 because the stub itself is "successful") |

Inconsistency to flag: `cmd-budget.ts:30` returns `0` for the deferred stub, while `cli.ts:898` returns `64` for sibling deferred commands.

### Registration pattern in `cli.ts` (NOT `cli/index.ts` — there is no index.ts)

`main()` lives at `src/cli.ts:691-903`. Each command is a flat `if (cmd === 'X')` branch:

```typescript
// cli.ts:715       — single-word command with subcommand dispatcher
if (cmd === 'budget') return dispatchBudget(rest);

// cli.ts:721-731   — direct command with flag parsing
if (cmd === 'history') {
  const flags = parseFlags(rest);
  const limitRaw = lastOption(flags, 'limit');
  const { executeHistoryCommand } = await import('./cli/cmd-history.js');
  return executeHistoryCommand({...}, io);
}

// cli.ts:797-801   — info pattern (passes VERSION too)
if (cmd === 'info') {
  const flags = parseFlags(rest);
  const { executeInfoCommand } = await import('./cli/cmd-info.js');
  return executeInfoCommand({ json: isBool(flags, 'json') }, io, VERSION);
}
```

Subcommand dispatchers (e.g. `dispatchBudget` :640, `dispatchMemory` referenced :706, `dispatchContext` :710, `dispatchRun` :713, `dispatchVerify` :714) are local functions in `cli.ts` itself. `memory recent` and `memory recall` are dispatched from `dispatchMemory(rest)` (definition not in the lines read but referenced at `:706`; help text shows them at `:83, :125`).

**Note:** `cmd-memory-recall.ts` does **NOT** exist as a standalone file (`find` confirms). Recall logic is inline in `cli.ts` via `dispatchMemory`. Only `cmd-memory-recall-cwd-default.test.ts` exists.

All command imports are **dynamic** (`await import('./cli/cmd-*.js')`) to keep cold-start fast — pattern used at `:650, 718, 724, 736, 741, 758, 777, 786, 799, 804, 811, 819, 833, 847, 861, 880, 883, 888`.

---

## 6. Memory migrations file — `src/memory/db-migrations.ts`

**No `schema_version`/`user_version` table or PRAGMA used.** Migrations are entirely **unversioned**, idempotency-only:

- `PRE_ALTER_DDL` array (`:15-37`) — `CREATE TABLE IF NOT EXISTS memories` + 4 indexes (idx_type, idx_workdir, idx_accessed, idx_created)
- `POST_ALTER_DDL` array (`:39-57`) — index on `entity_key` (depends on ALTER), FTS5 `memories_fts`, insert+delete triggers
- `migrateMemoryTables(db)` (`:59-113`):
  - phase 1: run all PRE_ALTER_DDL (`:61-63`)
  - phase 2: PRAGMA-guarded ALTERs for 8 optional columns (`:65-93`) — `entity_key`, `sources_json`, `recall_count`, `content_hash` (+ its index), `memory_source`, `success_recall_count`, `trust_level`, `files_json`
  - phase 3: run all POST_ALTER_DDL (`:96-98`)
  - phase 4: backfill FTS index if memories exist but FTS is empty (`:101-112`)

**Pattern is identical to db.ts:** `PRAGMA table_info(<table>)` → `Set` of column names → `if (!cols.has('X')) ALTER ADD COLUMN X`. Same model used 11× in `db.ts` (`migrateTasksLeaseFields` :284, `migrateRunsVerificationStatus` :304, etc.).

**Implication for ROADMAP #1:** Introducing `schema_version` is a **new** concept across the codebase. Both `db.ts` migrations and `db-migrations.ts` (memory, budget, capability, auth) would need to be retrofitted with version checks if monotonic versioning is the goal. The current state is "every migration is idempotent and always safe to re-run" — the new requirement is "DROP migrations need a version gate so they don't re-drop on every boot."

---

## 7. Action surface for v0.2 (synthesis)

**For ROADMAP #1 (schema cleanup):**
1. Add `schema_version` table at top of `DDL_STATEMENTS` (`db.ts:15`).
2. Add `migrateDropOrphansV02(db)` near `db.ts:426`, guarded by `SELECT FROM schema_version`.
3. Drop in FK order: `task_deps`, `tasks`, `jobs`, `job_events`, `sign_off_amendments`, sign_off triggers, `sign_offs`, `recipes`, `continuity_objects`, `proxy_requests`, `operator_annotations`, `verifications` (after confirming `purgeTaintedVerificationRecords` :402-404 is no longer needed).
4. Remove DDL entries from `DDL_STATEMENTS` for dropped tables.
5. Remove orphan migration functions: `migrateTasksLeaseFields` :284, `migrateRunsVerificationStatus` :304, `migrateVerificationsConfidenceScore` :316, `migrateVerificationsSource` :329, `migrateProxyRequestsFullBody` :340.

**For ROADMAP #7 (budget command):**
1. Extend `scope` CHECK in `budget-store.ts` migration (`db-migrations.ts:7, 24`) to include `provider` and `workdir`.
2. Add scope branches in `getCurrentCost` (`budget-store.ts:32-65`) and skip guard in `checkBudgets` (`:140`).
3. Replace stub at `cmd-budget.ts:19-31` with real implementation calling `BudgetStore.listBudgetLimits` / `listBudgetAlerts`.
4. Add `set`, `list`, `alerts` actions to `dispatchBudget` (`cli.ts:640-656`) alongside `show`.
5. Update help text at `cli.ts:244` (currently mentions `0.2.0` deferred).

---

*Map produced by direct file read + grep verification. Every claim above is backed by a file:line citation.*
